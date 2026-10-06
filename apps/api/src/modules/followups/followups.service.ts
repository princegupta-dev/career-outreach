import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Outreach, Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit.service';
import { MetricsService } from '../../common/metrics.service';
import { PrismaService } from '../../common/prisma.service';
import { CANCELLABLE_FOLLOWUP_STATUSES, planFollowups, rescheduleAfter, SendWindow } from '../../domain/followups/schedule';
import { cumulativeDays, UserSettings } from '../../domain/settings';
import { QueueService } from '../queues/queues';
import { SettingsService } from '../settings/settings.service';
import { EmailAccountsService } from '../email/email-accounts.service';

type Tx = Prisma.TransactionClient | PrismaService;

export function sendWindowFor(s: UserSettings): SendWindow {
  return { timezone: s.timezone, startHour: s.followups.sendWindowStartHour, endHour: s.followups.sendWindowEndHour, skipWeekends: s.followups.skipWeekends };
}

/** Scheduling and cancellation of follow-ups. Cancellation is the critical safety path. */
@Injectable()
export class FollowupsService {
  private readonly logger = new Logger(FollowupsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly queues: QueueService,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
    private readonly accounts: EmailAccountsService,
  ) {}

  /** Delete mailbox drafts of cancelled follow-ups of a thread (call after the cancelling transaction committed). */
  async cleanupCancelledDrafts(rootId: string): Promise<void> {
    const rows = await this.prisma.outreach.findMany({ where: { rootId, status: 'CANCELLED', gmailDraftId: { not: null } }, select: { id: true } });
    await this.deleteMailboxDrafts(rows.map((r) => r.id));
  }

  /** Remove mirrored mailbox drafts so a cancelled follow-up can't be sent by accident. */
  private async deleteMailboxDrafts(outreachIds: string[]): Promise<void> {
    if (!outreachIds.length) return;
    const rows = await this.prisma.outreach.findMany({ where: { id: { in: outreachIds }, gmailDraftId: { not: null } }, include: { emailAccount: true } });
    for (const r of rows) {
      if (!r.emailAccount || !r.gmailDraftId) continue;
      try {
        await this.accounts.providerFor(r.emailAccount).deleteDraft(this.accounts.mailbox(r.emailAccount), r.gmailDraftId);
        await this.prisma.outreach.update({ where: { id: r.id }, data: { gmailDraftId: null } });
      } catch (e) {
        this.logger.warn({ msg: 'Could not delete mailbox draft', outreachId: r.id, error: (e as Error).message });
      }
    }
  }

  /** Create the follow-up plan for a sent initial email. Idempotent (unique rootId+sequence). */
  async scheduleForRoot(root: Outreach, tx: Tx = this.prisma): Promise<number> {
    if (root.kind !== 'INITIAL' || !root.sentAt) return 0;
    const s = await this.settings.get(root.userId);
    if (!s.followups.enabled || !s.followups.delaysDays.length) return 0;
    const plan = planFollowups(root.sentAt, s.followups.delaysDays, sendWindowFor(s));
    const r = await tx.followup.createMany({
      data: plan.map((p) => ({ userId: root.userId, rootId: root.id, sequence: p.sequence, scheduledAt: p.scheduledAt })),
      skipDuplicates: true,
    });
    return r.count;
  }

  /** After follow-up N is sent, keep N+1 on its day-N target but at least 2 days after N. */
  async rescheduleNext(rootId: string, sentSequence: number, sentAt: Date): Promise<void> {
    const next = await this.prisma.followup.findUnique({ where: { rootId_sequence: { rootId, sequence: sentSequence + 1 } }, include: { root: true } });
    if (!next || next.status !== 'SCHEDULED' || !next.root.sentAt) return;
    const s = await this.settings.get(next.userId);
    const cumulative = cumulativeDays(s.followups.delaysDays)[sentSequence] ?? cumulativeDays(s.followups.delaysDays).at(-1) ?? 16;
    await this.prisma.followup.update({ where: { id: next.id }, data: { scheduledAt: rescheduleAfter(next.root.sentAt, cumulative, sentAt, sendWindowFor(s)) } });
  }

  /**
   * Cancel every pending follow-up of a thread (reply, bounce, close, unsubscribe).
   * Also cancels their draft emails and removes any queued send jobs.
   */
  async cancelForRoot(rootId: string, reason: string, tx: Tx = this.prisma): Promise<number> {
    const pending = await tx.followup.findMany({ where: { rootId, status: { in: CANCELLABLE_FOLLOWUP_STATUSES } } });
    if (!pending.length) return 0;
    await tx.followup.updateMany({ where: { id: { in: pending.map((f) => f.id) } }, data: { status: 'CANCELLED', cancelReason: reason } });
    const outreachIds = pending.map((f) => f.outreachId).filter((x): x is string => !!x);
    if (outreachIds.length) {
      await tx.outreach.updateMany({ where: { id: { in: outreachIds }, status: { in: ['DRAFT', 'APPROVED', 'FAILED'] } }, data: { status: 'CANCELLED', error: reason } });
    }
    await tx.emailEvent.create({ data: { userId: pending[0].userId, outreachId: rootId, type: 'FOLLOWUP_CANCELLED', metadata: { reason, count: pending.length } } });
    // Queue/mailbox cleanup is outside the DB transaction; the send worker re-checks state anyway.
    for (const id of outreachIds) await this.queues.cancelSend(id).catch(() => undefined);
    // Inside a DB transaction the caller runs cleanupCancelledDrafts() after commit (no network I/O in transactions).
    if (tx === this.prisma) await this.deleteMailboxDrafts(outreachIds);
    await this.metrics.record('followup.cancelled', { rootId, count: pending.length, reason });
    this.logger.log({ msg: 'Follow-ups cancelled', rootId, count: pending.length, reason });
    return pending.length;
  }

  async listPending(userId: string) {
    return this.prisma.followup.findMany({
      where: { userId, status: { in: ['SCHEDULED', 'DRAFT_READY', 'APPROVED', 'FAILED'] } },
      orderBy: { scheduledAt: 'asc' },
      include: {
        outreach: { select: { id: true, subject: true, body: true, status: true, warnings: true } },
        root: {
          select: {
            id: true,
            subject: true,
            toEmail: true,
            threadState: true,
            sentAt: true,
            contact: { select: { name: true } },
            application: { select: { id: true, job: { select: { id: true, title: true, company: { select: { name: true } } } } } },
          },
        },
      },
    });
  }

  async get(userId: string, id: string) {
    const f = await this.prisma.followup.findFirst({ where: { id, userId }, include: { root: true, outreach: true } });
    if (!f) throw new NotFoundException('Follow-up not found');
    return f;
  }

  /** Skip one follow-up; the next one in the sequence can still go out. */
  async skip(userId: string, id: string) {
    const f = await this.get(userId, id);
    await this.prisma.followup.update({ where: { id }, data: { status: 'SKIPPED', cancelReason: 'Skipped by user' } });
    if (f.outreachId) {
      await this.prisma.outreach.updateMany({ where: { id: f.outreachId, status: { in: ['DRAFT', 'APPROVED'] } }, data: { status: 'CANCELLED' } });
      await this.queues.cancelSend(f.outreachId);
      await this.deleteMailboxDrafts([f.outreachId]);
    }
    await this.audit.log('followup.skipped', { userId, entityType: 'followup', entityId: id });
  }

  async cancelAll(userId: string, rootId: string) {
    const root = await this.prisma.outreach.findFirst({ where: { id: rootId, userId } });
    if (!root) throw new NotFoundException('Outreach not found');
    const n = await this.cancelForRoot(rootId, 'Cancelled by user');
    await this.audit.log('followup.cancelled_all', { userId, entityType: 'outreach', entityId: rootId, metadata: { count: n } });
    return { cancelled: n };
  }
}
