import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser, ZodPipe } from '../../common/http';
import { PrismaService } from '../../common/prisma.service';
import { nextActionFor } from '../../domain/applications/state-machine';
import { AiService } from '../ai/ai.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { ApplicationsService } from '../applications/applications.service';
import { EmailAccountsService } from '../email/email-accounts.service';

const PIPELINE_GROUPS = {
  Discovered: ['DISCOVERED'],
  Qualified: ['QUALIFIED', 'SHORTLISTED'],
  Outreach: ['CONTACT_FOUND', 'RESUME_READY', 'EMAIL_READY', 'EMAIL_SENT'],
  Waiting: ['WAITING_FOR_REPLY', 'FOLLOWUP_SCHEDULED'],
  Replied: ['REPLIED'],
  Interview: ['INTERVIEW'],
  Offer: ['OFFER'],
} as const;

@Controller()
export class DashboardController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly applications: ApplicationsService,
    private readonly analytics: AnalyticsService,
    private readonly accounts: EmailAccountsService,
    private readonly ai: AiService,
  ) {}

  @Get('dashboard')
  async dashboard(@CurrentUser() user: AuthUser) {
    const [report, counts, drafts, followupDrafts, failed, replies, topJobs, email] = await Promise.all([
      this.analytics.get(user.id),
      this.applications.pipelineCounts(user.id),
      this.prisma.outreach.count({ where: { userId: user.id, kind: 'INITIAL', status: 'DRAFT' } }),
      this.prisma.followup.count({ where: { userId: user.id, status: 'DRAFT_READY' } }),
      this.prisma.outreach.count({ where: { userId: user.id, status: 'FAILED' } }),
      this.prisma.application.findMany({
        where: { userId: user.id, status: 'REPLIED', deletedAt: null },
        take: 5,
        orderBy: { statusChangedAt: 'desc' },
        select: { id: true, replySentiment: true, job: { select: { id: true, title: true, company: { select: { name: true } } } } },
      }),
      this.prisma.job.findMany({
        where: { userId: user.id, deletedAt: null, application: { status: { notIn: ['CLOSED', 'REJECTED'] } } },
        orderBy: [{ score: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
        take: 12,
        select: {
          id: true,
          title: true,
          location: true,
          remote: true,
          score: true,
          recommendation: true,
          salaryMin: true,
          salaryMax: true,
          salaryCurrency: true,
          salaryPeriod: true,
          company: { select: { name: true } },
          application: { select: { id: true, status: true, contact: { select: { name: true, role: true } } } },
        },
      }),
      this.accounts.status(user.id),
    ]);
    const t = report.totals;
    return {
      stats: {
        jobsDiscovered: t.jobsDiscovered,
        strongMatches: t.strongMatches,
        emailsSent: t.emailsSent,
        replies: t.replies,
        replyRate: t.replyRate,
        interviews: t.interviews,
        offers: t.offers,
        pendingFollowups: t.pendingFollowups,
      },
      pipeline: Object.entries(PIPELINE_GROUPS).map(([label, statuses]) => ({ label, statuses, count: statuses.reduce((a, s) => a + counts[s], 0) })),
      statusCounts: counts,
      actions: { draftsToReview: drafts, followupDraftsToReview: followupDrafts, failedSends: failed, repliesToAnswer: replies },
      jobs: topJobs.map((j) => ({ ...j, nextAction: j.application ? nextActionFor(j.application.status) : null })),
      setup: {
        emailMode: email.mode,
        gmailConnected: email.accounts.some((a) => a.provider === 'GMAIL' && a.status === 'CONNECTED'),
        ai: { ...this.ai.status(), circuit: await this.ai.circuit() },
      },
    };
  }

  @Get('analytics')
  analyticsReport(@CurrentUser() user: AuthUser, @Query(new ZodPipe(z.object({ fresh: z.enum(['0', '1']).optional() }))) q: { fresh?: string }) {
    return this.analytics.get(user.id, q.fresh === '1');
  }
}
