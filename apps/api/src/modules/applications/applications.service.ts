import { Injectable, NotFoundException } from '@nestjs/common';
import type { ApplicationStatus, Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { PrismaService } from '../../common/prisma.service';
import { ACTION_TARGET, ActionContext, lifecycleOf, LifecycleAction } from '../../domain/applications/lifecycle';
import { assertTransition, canSystemAdvance, nextActionFor, PIPELINE_ORDER, shouldAutoAdvance } from '../../domain/applications/state-machine';

type Tx = Prisma.TransactionClient | PrismaService;

@Injectable()
export class ApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly analytics: AnalyticsService,
  ) {}

  async get(userId: string, id: string) {
    const app = await this.prisma.application.findFirst({ where: { id, userId, deletedAt: null }, include: { job: { include: { company: true } }, contact: true } });
    if (!app) throw new NotFoundException('Application not found');
    return app;
  }

  /** Manual status change (validated by the state machine). */
  async transition(userId: string, id: string, to: ApplicationStatus, note?: string) {
    const app = await this.get(userId, id);
    assertTransition(app.status, to);
    const updated = await this.prisma.application.update({
      where: { id },
      data: { status: to, statusChangedAt: new Date(), ...(note ? { notes: [app.notes, note].filter(Boolean).join('\n') } : {}) },
    });
    // Closing / rejecting / interviewing means follow-ups must stop.
    if (['REJECTED', 'CLOSED', 'INTERVIEW', 'OFFER', 'REPLIED'].includes(to)) {
      const roots = await this.prisma.outreach.findMany({ where: { applicationId: id, kind: 'INITIAL' }, select: { id: true } });
      await this.prisma.followup.updateMany({
        where: { rootId: { in: roots.map((r) => r.id) }, status: { in: ['SCHEDULED', 'DRAFT_READY', 'APPROVED', 'FAILED'] } },
        data: { status: 'CANCELLED', cancelReason: `Application moved to ${to}` },
      });
      if (to === 'CLOSED' || to === 'REJECTED') {
        await this.prisma.outreach.updateMany({ where: { id: { in: roots.map((r) => r.id) }, threadState: 'WAITING_FOR_REPLY' }, data: { threadState: 'CLOSED' } });
      }
    }
    await this.analytics.invalidate(userId);
    await this.audit.log('application.status_changed', { userId, entityType: 'application', entityId: id, metadata: { from: app.status, to, note } });
    return updated;
  }

  /** System-driven progress through pre-send stages; never moves backwards. */
  async autoAdvance(applicationId: string, target: ApplicationStatus, tx: Tx = this.prisma): Promise<boolean> {
    const app = await tx.application.findUnique({ where: { id: applicationId }, select: { status: true } });
    if (!app || !shouldAutoAdvance(app.status, target)) return false;
    await tx.application.update({ where: { id: applicationId }, data: { status: target, statusChangedAt: new Date() } });
    return true;
  }

  /** System-driven transition used by sending / reply detection (validated). */
  async systemTransition(applicationId: string, target: ApplicationStatus, tx: Tx = this.prisma): Promise<boolean> {
    const app = await tx.application.findUnique({ where: { id: applicationId }, select: { status: true } });
    if (!app || !canSystemAdvance(app.status, target)) return false;
    await tx.application.update({ where: { id: applicationId }, data: { status: target, statusChangedAt: new Date() } });
    return true;
  }

  /** Statuses the preparation workflow may move an application between (never past the user's own decisions). */
  private static readonly WORKFLOW_OWNED: ApplicationStatus[] = ['DISCOVERED', 'QUALIFIED', 'SHORTLISTED', 'CONTACT_FOUND', 'RESUME_READY', 'EMAIL_READY', 'PREPARING', 'READY_FOR_REVIEW'];

  /** Preparing ⇄ Ready for review. A no-op once the user has skipped, approved, or applied. */
  async moveForWorkflow(applicationId: string, target: 'PREPARING' | 'READY_FOR_REVIEW'): Promise<boolean> {
    const r = await this.prisma.application.updateMany({
      where: { id: applicationId, status: { in: ApplicationsService.WORKFLOW_OWNED, not: target } },
      data: { status: target, statusChangedAt: new Date() },
    });
    return r.count > 0;
  }

  /** Approval of the prepared package (called only after the user's explicit approval). */
  async approvePackage(applicationId: string): Promise<boolean> {
    const r = await this.prisma.application.updateMany({
      where: { id: applicationId, status: { in: ['READY_FOR_REVIEW', 'EMAIL_READY', 'PREPARING'] } },
      data: { status: 'APPROVED', statusChangedAt: new Date() },
    });
    return r.count > 0;
  }

  /** The user's explicit lifecycle choices: shortlist, skip, restore, archive, "I applied". Validated by the state machine. */
  async lifecycleAction(userId: string, applicationId: string, action: LifecycleAction) {
    return this.transition(userId, applicationId, ACTION_TARGET[action]);
  }

  async pipelineCounts(userId: string): Promise<Record<ApplicationStatus, number>> {
    const rows = await this.prisma.application.groupBy({ by: ['status'], where: { userId, deletedAt: null }, _count: true });
    const counts = Object.fromEntries(PIPELINE_ORDER.map((s) => [s, 0])) as Record<ApplicationStatus, number>;
    for (const r of rows) counts[r.status] = r._count;
    return counts;
  }

  nextAction(status: ApplicationStatus): string {
    return nextActionFor(status);
  }

  /** Stage, one next action, and whether it needs the user — for the job page and list. */
  lifecycle(status: ApplicationStatus, ctx: ActionContext = {}) {
    return lifecycleOf(status, ctx);
  }
}
