import { Injectable, Logger } from '@nestjs/common';
import { MetricsService } from '../../common/metrics.service';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import { decideFollowup } from '../../domain/followups/schedule';
import { isSuppressed } from '../../domain/outreach/guardrails';
import { EmailSyncService } from '../email/email-sync.service';
import { OutreachService } from '../outreach/outreach.service';
import { QueueService } from '../queues/queues';
import { SettingsService } from '../settings/settings.service';
import { FollowupsService } from './followups.service';

/** Prepare drafts this far ahead of the due time so you can review them. */
const PREPARE_AHEAD_MS = 24 * 3600 * 1000;

export interface TickStats {
  checked: number;
  draftsPrepared: number;
  cancelled: number;
  queued: number;
  errors: number;
}

/**
 * Periodic follow-up engine (runs in the worker):
 *  1. For follow-ups coming due: live-check the mailbox for a reply.
 *     Replied → cancel everything. Otherwise prepare a draft.
 *  2. Auto-send mode: approve + queue. Manual mode (default): wait for approval.
 *  3. Safety net: approved + due follow-ups get (re)queued.
 */
@Injectable()
export class FollowupRunnerService {
  private readonly logger = new Logger(FollowupRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly followups: FollowupsService,
    private readonly outreach: OutreachService,
    private readonly sync: EmailSyncService,
    private readonly settings: SettingsService,
    private readonly queues: QueueService,
    private readonly metrics: MetricsService,
  ) {}

  async tick(now = new Date()): Promise<TickStats> {
    const stats: TickStats = { checked: 0, draftsPrepared: 0, cancelled: 0, queued: 0, errors: 0 };
    const release = await this.redis.acquireLock('followup-tick', 10 * 60_000);
    if (!release) return stats;
    try {
      const upcoming = await this.prisma.followup.findMany({
        where: { status: 'SCHEDULED', scheduledAt: { lte: new Date(now.getTime() + PREPARE_AHEAD_MS) } },
        orderBy: { scheduledAt: 'asc' },
        take: 100,
        include: { root: true },
      });
      for (const f of upcoming) {
        stats.checked++;
        try {
          const replied = (await this.sync.syncRootById(f.rootId)).replied;
          const root = await this.prisma.outreach.findUniqueOrThrow({ where: { id: f.rootId } });
          const prev = f.sequence > 1 ? await this.prisma.followup.findUnique({ where: { rootId_sequence: { rootId: f.rootId, sequence: f.sequence - 1 } } }) : null;
          const suppressions = await this.prisma.suppression.findMany({ where: { userId: f.userId }, select: { value: true } });
          const decision = decideFollowup({
            threadState: root.threadState,
            followupStatus: f.status,
            scheduledAt: now, // preparing early is fine; sending re-checks the real due time
            now,
            replyDetected: replied,
            suppressed: isSuppressed(root.toEmail, suppressions.map((s) => s.value)),
            previousSequenceSent: f.sequence === 1 ? root.status === 'SENT' : !!prev && ['SENT', 'SKIPPED'].includes(prev.status),
          });
          if (decision.action === 'cancel') {
            stats.cancelled += await this.followups.cancelForRoot(f.rootId, decision.reason);
            continue;
          }
          if (decision.action === 'wait') continue;
          const draft = await this.outreach.generateFollowupDraft(f.id);
          stats.draftsPrepared++;
          const s = await this.settings.get(f.userId);
          // Follow-ups go out unreviewed only when BOTH automatic sending and follow-up auto-send are on.
          if (s.followups.autoSend && s.outreach.sendMode === 'AUTO_SEND') {
            await this.outreach.approve(f.userId, draft.id);
            stats.queued++;
          }
        } catch (e) {
          stats.errors++;
          await this.metrics.record('followup.failure', { followupId: f.id, error: (e as Error).message });
        }
      }

      // Safety net: approved follow-ups that are due but have no pending send job.
      const due = await this.prisma.followup.findMany({ where: { status: 'APPROVED', scheduledAt: { lte: now }, outreachId: { not: null } }, take: 100 });
      for (const f of due) {
        await this.queues.send({ userId: f.userId, outreachId: f.outreachId! });
        stats.queued++;
      }
      if (stats.checked || stats.queued) this.logger.log({ msg: 'Follow-up tick', ...stats });
      return stats;
    } finally {
      await release();
    }
  }
}
