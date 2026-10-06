import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { AuthUser, CurrentUser, DomainError, RateLimit, ZodPipe } from '../../common/http';
import { PrismaService } from '../../common/prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { ApplicationsService } from '../applications/applications.service';
import { QueueService } from '../queues/queues';
import { DiscoveryService } from './discovery.service';

const interviewSchema = z.object({
  stage: z.string().trim().min(1).max(100),
  scheduledAt: z.string().datetime({ offset: true }).nullish(),
  notes: z.string().max(5000).nullish(),
  outcome: z.enum(['PENDING', 'PASSED', 'FAILED', 'CANCELLED']).optional(),
});

@Controller()
export class DiscoveryController {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly queues: QueueService,
    private readonly prisma: PrismaService,
    private readonly applications: ApplicationsService,
    private readonly analytics: AnalyticsService,
    private readonly audit: AuditService,
  ) {}

  /** Today's opportunities: "We found X relevant jobs for you today." */
  @Get('discovery/today')
  today(@CurrentUser() user: AuthUser) {
    return this.discovery.today(user.id);
  }

  /** Search all sources now (runs in the worker; poll /discovery/today). */
  @Post('discovery/run')
  @HttpCode(202)
  @RateLimit({ name: 'discovery', limit: 6, windowSec: 600 })
  async run(@CurrentUser() user: AuthUser) {
    await this.queues.discover({ userId: user.id, trigger: 'manual' });
    return { queued: true };
  }

  @Get('discovery/runs')
  runs(@CurrentUser() user: AuthUser) {
    return this.prisma.discoveryRun.findMany({ where: { userId: user.id }, orderBy: { startedAt: 'desc' }, take: 10 });
  }

  // ─── Interviews ────────────────────────────────────────────────────────────

  @Get('interviews')
  upcoming(@CurrentUser() user: AuthUser) {
    return this.prisma.interview.findMany({
      where: { userId: user.id, outcome: 'PENDING' },
      orderBy: [{ scheduledAt: { sort: 'asc', nulls: 'last' } }],
      take: 20,
      include: { application: { select: { id: true, job: { select: { id: true, title: true, company: { select: { name: true } } } } } } },
    });
  }

  @Get('applications/:id/interviews')
  async list(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.applications.get(user.id, id);
    return this.prisma.interview.findMany({ where: { applicationId: id }, orderBy: { createdAt: 'asc' } });
  }

  @Post('applications/:id/interviews')
  async create(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(interviewSchema)) body: z.infer<typeof interviewSchema>) {
    await this.applications.get(user.id, id);
    const interview = await this.prisma.interview.create({
      data: { userId: user.id, applicationId: id, stage: body.stage, scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null, notes: body.notes ?? null, outcome: body.outcome ?? 'PENDING' },
    });
    // An interview is a fact: move the application forward and stop any follow-ups.
    if (await this.applications.systemTransition(id, 'INTERVIEW')) {
      const roots = await this.prisma.outreach.findMany({ where: { applicationId: id, kind: 'INITIAL' }, select: { id: true } });
      await this.prisma.followup.updateMany({ where: { rootId: { in: roots.map((r) => r.id) }, status: { in: ['SCHEDULED', 'DRAFT_READY', 'APPROVED', 'FAILED'] } }, data: { status: 'CANCELLED', cancelReason: 'Interview scheduled' } });
    }
    await this.analytics.invalidate(user.id);
    await this.audit.log('interview.created', { userId: user.id, entityType: 'application', entityId: id, metadata: { stage: body.stage } });
    return interview;
  }

  @Patch('interviews/:id')
  async update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(interviewSchema.partial())) body: Partial<z.infer<typeof interviewSchema>>) {
    const existing = await this.prisma.interview.findFirst({ where: { id, userId: user.id } });
    if (!existing) throw new DomainError('Interview not found', 404);
    return this.prisma.interview.update({
      where: { id },
      data: {
        ...(body.stage ? { stage: body.stage } : {}),
        ...(body.scheduledAt !== undefined ? { scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        ...(body.outcome ? { outcome: body.outcome } : {}),
      },
    });
  }
}
