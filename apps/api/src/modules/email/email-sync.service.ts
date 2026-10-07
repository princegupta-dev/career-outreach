import { Injectable, Logger } from '@nestjs/common';
import type { EmailAccount, Outreach } from '@prisma/client';
import { MetricsService } from '../../common/metrics.service';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import { classifyInbound, extractAddress, isUnsubscribeRequest, replySentiment } from '../../domain/email/classify-reply';
import { emailDomain, normalizeEmail } from '../../domain/dedupe';
import { EmailProviderError, MessageMeta } from '../../providers/email/email-provider.interface';
import { ApplicationsService } from '../applications/applications.service';
import { FollowupsService } from '../followups/followups.service';
import { EmailAccountsService } from './email-accounts.service';

export interface SyncResult {
  replied: boolean;
  bounced: boolean;
  autoReplies: number;
}

const MAX_SYNC_AGE_DAYS = 90;

/**
 * Reply detection. For every thread waiting for a reply, read the Gmail thread
 * (and messages from the contact that started a new thread). A real reply marks
 * the thread REPLIED and cancels every pending follow-up immediately.
 */
@Injectable()
export class EmailSyncService {
  private readonly logger = new Logger(EmailSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly accounts: EmailAccountsService,
    private readonly followups: FollowupsService,
    private readonly applications: ApplicationsService,
    private readonly metrics: MetricsService,
  ) {}

  async syncUser(userId: string): Promise<{ threads: number; replies: number; bounces: number; errors: number }> {
    const release = await this.redis.acquireLock(`sync:${userId}`, 5 * 60_000);
    if (!release) return { threads: 0, replies: 0, bounces: 0, errors: 0 };
    const stats = { threads: 0, replies: 0, bounces: 0, errors: 0 };
    try {
      const roots = await this.prisma.outreach.findMany({
        where: {
          userId,
          kind: 'INITIAL',
          threadState: 'WAITING_FOR_REPLY',
          sentAt: { gte: new Date(Date.now() - MAX_SYNC_AGE_DAYS * 86_400_000) },
        },
        include: { emailAccount: true },
      });
      for (const root of roots) {
        if (!root.emailAccount || root.emailAccount.status !== 'CONNECTED') continue;
        stats.threads++;
        try {
          const r = await this.syncRoot(root, root.emailAccount);
          if (r.replied) stats.replies++;
          if (r.bounced) stats.bounces++;
        } catch (e) {
          stats.errors++;
          await this.metrics.record('gmail.failure', { op: 'sync', rootId: root.id, error: (e as Error).message });
          if (e instanceof EmailProviderError && e.authError) break;
        }
      }
      const accountIds = [...new Set(roots.map((r) => r.emailAccountId).filter((x): x is string => !!x))];
      if (accountIds.length) await this.prisma.emailAccount.updateMany({ where: { id: { in: accountIds } }, data: { lastSyncAt: new Date() } });
      return stats;
    } finally {
      await release();
    }
  }

  /** Live check for one thread (also used right before any follow-up is sent). */
  async syncRootById(rootId: string): Promise<SyncResult> {
    const root = await this.prisma.outreach.findUniqueOrThrow({ where: { id: rootId }, include: { emailAccount: true } });
    if (!root.emailAccount || !root.gmailThreadId) return { replied: root.threadState === 'REPLIED', bounced: root.threadState === 'BOUNCED', autoReplies: 0 };
    return this.syncRoot(root, root.emailAccount);
  }

  async syncRoot(root: Outreach, account: EmailAccount): Promise<SyncResult> {
    const result: SyncResult = { replied: root.threadState === 'REPLIED', bounced: root.threadState === 'BOUNCED', autoReplies: 0 };
    if (!root.gmailThreadId || !root.sentAt) return result;
    const provider = this.accounts.providerFor(account);
    const mailbox = this.accounts.mailbox(account);

    const [threadMsgs, fromContact] = await Promise.all([
      provider.getThread(mailbox, root.gmailThreadId),
      provider.searchFrom(mailbox, root.toEmail, new Date(root.sentAt.getTime() - 60_000)),
    ]);
    const ours = await this.prisma.outreach.findMany({ where: { OR: [{ id: root.id }, { rootId: root.id }] }, select: { gmailMessageId: true } });
    const ourIds = new Set(ours.map((o) => o.gmailMessageId).filter(Boolean));
    const seen = new Set<string>();
    const inbound = [...threadMsgs, ...fromContact]
      .filter((m) => !ourIds.has(m.id) && !seen.has(m.id) && seen.add(m.id))
      .filter((m) => m.date.getTime() >= root.sentAt!.getTime() - 60_000)
      .sort((a, b) => a.date.getTime() - b.date.getTime());

    for (const msg of inbound) {
      const kind = classifyInbound(msg, [account.email]);
      if (kind === 'self') continue;
      if (kind === 'reply') {
        // A reply must come from the recipient's address or domain, or sit in our thread.
        const from = extractAddress(msg.from);
        const relevant = msg.threadId === root.gmailThreadId || from === normalizeEmail(root.toEmail) || emailDomain(from) === emailDomain(root.toEmail);
        if (!relevant) continue;
        await this.recordReply(root, msg);
        result.replied = true;
      } else if (kind === 'auto_reply') {
        const created = await this.recordEvent(root, msg, 'AUTO_REPLY');
        if (created) result.autoReplies++;
      } else if (kind === 'bounce' && msg.threadId === root.gmailThreadId) {
        await this.recordBounce(root, msg);
        result.bounced = true;
      }
    }
    return result;
  }

  private async recordEvent(root: Outreach, msg: MessageMeta, type: 'AUTO_REPLY' | 'REPLY_RECEIVED' | 'BOUNCE'): Promise<boolean> {
    try {
      await this.prisma.emailEvent.create({
        data: {
          userId: root.userId,
          outreachId: root.id,
          emailAccountId: root.emailAccountId,
          type,
          providerMessageId: msg.id,
          threadId: msg.threadId,
          fromEmail: extractAddress(msg.from),
          snippet: msg.snippet.slice(0, 200),
          occurredAt: msg.date,
          metadata: { subject: msg.subject.slice(0, 200) },
        },
      });
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return false; // already recorded (idempotent sync)
      throw e;
    }
  }

  /** REPLIED → cancel all follow-ups immediately (same transaction as the state change). */
  private async recordReply(root: Outreach, msg: MessageMeta): Promise<void> {
    const fresh = await this.recordEvent(root, msg, 'REPLY_RECEIVED');
    const sentiment = replySentiment(`${msg.subject} ${msg.snippet}`);
    await this.prisma.$transaction(async (tx) => {
      await tx.outreach.update({ where: { id: root.id }, data: { threadState: 'REPLIED', repliedAt: root.repliedAt ?? msg.date } });
      await this.followups.cancelForRoot(root.id, 'Recipient replied', tx);
      await this.applications.systemTransition(root.applicationId, 'REPLIED', tx);
      await tx.application.update({ where: { id: root.applicationId }, data: { replySentiment: sentiment } });
      if (isUnsubscribeRequest(msg.snippet)) {
        await tx.suppression.upsert({
          where: { userId_value: { userId: root.userId, value: normalizeEmail(root.toEmail) } },
          create: { userId: root.userId, value: normalizeEmail(root.toEmail), kind: 'email', reason: 'Recipient asked not to be contacted' },
          update: {},
        });
      }
    });
    await this.followups.cleanupCancelledDrafts(root.id);
    if (fresh) {
      await this.metrics.record('reply.detected', { rootId: root.id, sentiment });
      this.logger.log({ msg: 'Reply detected — follow-ups cancelled', rootId: root.id, sentiment });
    }
  }

  private async recordBounce(root: Outreach, msg: MessageMeta): Promise<void> {
    await this.recordEvent(root, msg, 'BOUNCE');
    await this.prisma.$transaction(async (tx) => {
      await tx.outreach.update({ where: { id: root.id }, data: { threadState: 'BOUNCED' } });
      await this.followups.cancelForRoot(root.id, 'Email bounced', tx);
      await tx.suppression.upsert({
        where: { userId_value: { userId: root.userId, value: normalizeEmail(root.toEmail) } },
        create: { userId: root.userId, value: normalizeEmail(root.toEmail), kind: 'email', reason: 'Bounced' },
        update: {},
      });
      await tx.contact.update({ where: { id: root.contactId }, data: { confidence: 'UNKNOWN', verificationStatus: 'BOUNCED', notes: 'Email bounced — address may be invalid' } });
    });
    await this.followups.cleanupCancelledDrafts(root.id);
  }
}
