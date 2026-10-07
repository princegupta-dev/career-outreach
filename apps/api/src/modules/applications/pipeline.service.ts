import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { emailDomain } from '../../domain/dedupe';
import { assertTransition, internalStatusesFor, PIPELINE_STATUSES, PipelineStatus, pipelineStatus } from '../../domain/applications/state-machine';
import type { MatchResult, ScoreBreakdown } from '../../domain/matching/scorer';
import { startOfLocalDay } from '../../domain/outreach/guardrails';
import { freshnessTier } from '../../providers/jobs/discovery-queries';
import { AnalyticsService } from '../analytics/analytics.service';
import { AuditService } from '../../common/audit.service';
import { SettingsService } from '../settings/settings.service';

const include = {
  job: {
    select: {
      id: true,
      title: true,
      url: true,
      applicationUrl: true,
      sourceUrl: true,
      location: true,
      remote: true,
      postedAt: true,
      createdAt: true,
      score: true,
      scoreBreakdown: true,
      salaryMin: true,
      salaryMax: true,
      salaryCurrency: true,
      salaryPeriod: true,
      experienceRequired: true,
      provider: true,
      company: { select: { id: true, name: true, domain: true } },
    },
  },
  contact: { select: { id: true, name: true, role: true, email: true, sourceType: true, sourceUrl: true, verificationStatus: true, confidence: true, discoveredAt: true } },
  resumeVersion: { select: { id: true, createdAt: true, compileStatus: true } },
  outreach: {
    select: { id: true, kind: true, sequence: true, status: true, threadState: true, toEmail: true, subject: true, sentAt: true, repliedAt: true, gmailMessageId: true, gmailThreadId: true },
    orderBy: { sequence: 'asc' as const },
  },
  interviews: { select: { stage: true, scheduledAt: true, outcome: true }, orderBy: { createdAt: 'desc' as const }, take: 1 },
} satisfies Prisma.ApplicationInclude;

type AppRow = Prisma.ApplicationGetPayload<{ include: typeof include }>;
type FollowupRow = { rootId: string; sequence: number; status: string; scheduledAt: Date };

/**
 * Dashboard view of applications. Everything is derived from the workflow tables
 * (jobs, contacts, outreach, follow-ups, interviews) — nothing is duplicated, so the
 * view can never disagree with what actually happened.
 */
@Injectable()
export class PipelineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly analytics: AnalyticsService,
    private readonly audit: AuditService,
  ) {}

  private async followupsFor(rootIds: string[]): Promise<FollowupRow[]> {
    if (!rootIds.length) return [];
    return this.prisma.followup.findMany({
      where: { rootId: { in: rootIds }, status: { in: ['SCHEDULED', 'DRAFT_READY', 'APPROVED'] } },
      select: { rootId: true, sequence: true, status: true, scheduledAt: true },
      orderBy: { scheduledAt: 'asc' },
    });
  }

  private view(a: AppRow, followups: FollowupRow[], now: Date) {
    const root = a.outreach.find((o) => o.kind === 'INITIAL' && o.sequence === 0) ?? a.outreach.find((o) => o.kind === 'INITIAL');
    const mine = root ? followups.filter((f) => f.rootId === root.id) : [];
    const followupDue = mine.some((f) => f.status === 'DRAFT_READY' || f.scheduledAt <= now);
    const sent = a.outreach.filter((o) => o.sentAt).map((o) => o.sentAt!.getTime());
    const match = a.job.scoreBreakdown as unknown as MatchResult | null;
    const breakdown: ScoreBreakdown | null = match?.breakdown ?? null;
    return {
      id: a.id,
      job_id: a.job.id,
      company: a.job.company.name,
      role: a.job.title,
      job_url: a.job.applicationUrl ?? a.job.url,
      source_url: a.job.sourceUrl ?? a.job.url,
      location: a.job.location,
      remote: a.job.remote,
      posting_date: a.job.postedAt,
      discovered_at: a.job.createdAt,
      freshness: freshnessTier(a.job.postedAt, now),
      experience_required: a.job.experienceRequired,
      salary: a.job.salaryMin || a.job.salaryMax ? { min: a.job.salaryMin, max: a.job.salaryMax, currency: a.job.salaryCurrency, period: a.job.salaryPeriod } : null,
      status: pipelineStatus(a.status, { followupDue }),
      internal_status: a.status,
      match_score: a.job.score,
      scoring: breakdown,
      resume_version: a.resumeVersion ? { id: a.resumeVersion.id, created_at: a.resumeVersion.createdAt, compile_status: a.resumeVersion.compileStatus } : null,
      application_date: a.appliedAt ?? root?.sentAt ?? null,
      contact_id: a.contactId,
      contact: a.contact
        ? {
            name: a.contact.name,
            role: a.contact.role,
            email: a.contact.email ?? 'EMAIL_NOT_FOUND',
            source_url: a.contact.sourceUrl,
            source_type: a.contact.sourceType,
            verification_status: a.contact.verificationStatus,
            confidence: a.contact.confidence,
            discovered_at: a.contact.discoveredAt,
          }
        : null,
      email_status: root ? (root.status === 'SENT' ? root.threadState : root.status) : a.contact?.email ? 'NOT_DRAFTED' : 'EMAIL_NOT_FOUND',
      email: root
        ? { message_id: root.gmailMessageId, thread_id: root.gmailThreadId, recipient: root.toEmail, subject: root.subject, sent_at: root.sentAt, status: root.status, reply_detected: root.threadState === 'REPLIED', reply_at: root.repliedAt }
        : null,
      last_contact_date: sent.length ? new Date(Math.max(...sent)) : null,
      next_followup_date: mine[0]?.scheduledAt ?? null,
      followups_pending: mine.length,
      reply_status: root?.threadState === 'REPLIED' ? 'REPLIED' : root?.threadState === 'BOUNCED' ? 'BOUNCED' : root?.sentAt ? 'NO_REPLY' : 'NOT_SENT',
      interview_stage: a.interviews[0]?.stage ?? null,
      notes: a.notes,
      created_at: a.createdAt,
      updated_at: a.updatedAt,
    };
  }

  async list(
    userId: string,
    q: { status?: PipelineStatus; search?: string; minScore?: number; freshness?: '24h' | '72h' | '7d'; sort?: 'score' | 'recent' | 'posted'; page?: number; pageSize?: number },
  ) {
    const now = new Date();
    const hours = q.freshness === '24h' ? 24 : q.freshness === '72h' ? 72 : q.freshness === '7d' ? 168 : null;
    const where: Prisma.ApplicationWhereInput = {
      userId,
      deletedAt: null,
      job: {
        deletedAt: null,
        ...(q.minScore != null ? { score: { gte: q.minScore } } : {}),
        ...(hours ? { postedAt: { gte: new Date(now.getTime() - hours * 3600_000) } } : {}),
        ...(q.search
          ? { OR: [{ title: { contains: q.search, mode: 'insensitive' } }, { company: { name: { contains: q.search, mode: 'insensitive' } } }, { location: { contains: q.search, mode: 'insensitive' } }] }
          : {}),
      },
      ...(q.status ? { status: { in: internalStatusesFor(q.status) } } : {}),
    };
    const pageSize = Math.min(100, q.pageSize ?? 25);
    const page = Math.max(1, q.page ?? 1);
    const orderBy: Prisma.ApplicationOrderByWithRelationInput[] =
      q.sort === 'recent'
        ? [{ createdAt: 'desc' }]
        : q.sort === 'posted'
          ? [{ job: { postedAt: { sort: 'desc', nulls: 'last' } } }]
          : [{ job: { score: { sort: 'desc', nulls: 'last' } } }, { createdAt: 'desc' }];
    // FOLLOW_UP_DUE / EMAIL_SENT share internal statuses — split them after loading.
    const splitDue = q.status === 'FOLLOW_UP_DUE' || q.status === 'EMAIL_SENT';
    const rows = await this.prisma.application.findMany({ where, include, orderBy, ...(splitDue ? {} : { skip: (page - 1) * pageSize, take: pageSize }) });
    const followups = await this.followupsFor(rows.flatMap((r) => r.outreach.filter((o) => o.kind === 'INITIAL').map((o) => o.id)));
    let items = rows.map((r) => this.view(r, followups, now));
    let total = splitDue ? 0 : await this.prisma.application.count({ where });
    if (splitDue) {
      items = items.filter((i) => i.status === q.status);
      total = items.length;
      items = items.slice((page - 1) * pageSize, page * pageSize);
    }
    return { total, page, pageSize, items };
  }

  async get(userId: string, id: string) {
    const a = await this.prisma.application.findFirst({ where: { id, userId, deletedAt: null }, include });
    if (!a) throw new NotFoundException('Application not found');
    const followups = await this.followupsFor(a.outreach.filter((o) => o.kind === 'INITIAL').map((o) => o.id));
    return this.view(a, followups, new Date());
  }

  /** The user applied on the company's portal. Recorded as a fact; a cold email may still follow. */
  async markApplied(userId: string, id: string, appliedAt?: Date, note?: string) {
    const app = await this.prisma.application.findFirst({ where: { id, userId, deletedAt: null } });
    if (!app) throw new NotFoundException('Application not found');
    const preSend = ['DISCOVERED', 'QUALIFIED', 'SHORTLISTED', 'CONTACT_FOUND', 'RESUME_READY', 'EMAIL_READY'].includes(app.status);
    if (preSend) assertTransition(app.status, 'APPLIED');
    await this.prisma.application.update({
      where: { id },
      data: {
        appliedAt: appliedAt ?? new Date(),
        ...(preSend ? { status: 'APPLIED', statusChangedAt: new Date() } : {}),
        ...(note ? { notes: [app.notes, note].filter(Boolean).join('\n') } : {}),
      },
    });
    await this.analytics.invalidate(userId);
    await this.audit.log('application.applied', { userId, entityType: 'application', entityId: id });
    return this.get(userId, id);
  }

  async summary(userId: string) {
    const now = new Date();
    const s = await this.settings.get(userId);
    const dayStart = startOfLocalDay(now, s.timezone);
    const sentStatuses = ['EMAIL_SENT', 'WAITING_FOR_REPLY', 'FOLLOWUP_SCHEDULED'] as const;
    const [grouped, dueApps, sentToday, initialToday, sentLastHour, jobsByAge, discoveredToday, followupsDue, awaitingApproval, notFound] = await Promise.all([
      this.prisma.application.groupBy({ by: ['status'], where: { userId, deletedAt: null, job: { deletedAt: null } }, _count: true }),
      this.prisma.application.count({
        where: {
          userId,
          deletedAt: null,
          job: { deletedAt: null },
          status: { in: [...sentStatuses] },
          outreach: { some: { kind: 'INITIAL', followups: { some: { OR: [{ status: 'DRAFT_READY' }, { status: { in: ['SCHEDULED', 'APPROVED'] }, scheduledAt: { lte: now } }] } } } },
        },
      }),
      this.prisma.outreach.count({ where: { userId, status: 'SENT', sentAt: { gte: dayStart } } }),
      this.prisma.outreach.count({ where: { userId, status: 'SENT', kind: 'INITIAL', sentAt: { gte: dayStart } } }),
      this.prisma.outreach.count({ where: { userId, status: 'SENT', sentAt: { gte: new Date(now.getTime() - 3600_000) } } }),
      Promise.all(
        [24, 72, 168].map((h) => this.prisma.job.count({ where: { userId, deletedAt: null, postedAt: { gte: new Date(now.getTime() - h * 3600_000) }, recommendation: { in: ['STRONG_APPLY', 'APPLY', 'CONSIDER'] } } })),
      ),
      this.prisma.job.count({ where: { userId, deletedAt: null, createdAt: { gte: dayStart } } }),
      this.prisma.followup.count({ where: { userId, OR: [{ status: 'DRAFT_READY' }, { status: 'SCHEDULED', scheduledAt: { lte: now } }] } }),
      this.prisma.outreach.count({ where: { userId, status: 'DRAFT' } }),
      this.prisma.application.count({ where: { userId, deletedAt: null, job: { recommendation: { in: ['STRONG_APPLY', 'APPLY'] } }, OR: [{ contactId: null }, { contact: { email: null } }] } }),
    ]);
    const byStatus = Object.fromEntries(PIPELINE_STATUSES.map((st) => [st, 0])) as Record<PipelineStatus, number>;
    for (const g of grouped) byStatus[pipelineStatus(g.status)] += g._count;
    byStatus.EMAIL_SENT -= dueApps;
    byStatus.FOLLOW_UP_DUE += dueApps;
    const o = s.outreach;
    return {
      byStatus,
      discovery: { discoveredToday, relevantPostedLast24h: jobsByAge[0], relevantPostedLast72h: jobsByAge[1], relevantPostedLast7d: jobsByAge[2] },
      outreach: {
        sendMode: o.sendMode,
        sentToday,
        initialSentToday: initialToday,
        sentLastHour,
        remainingToday: Math.max(0, o.dailyLimit - sentToday),
        remainingInitialToday: Math.max(0, o.dailyInitialLimit - initialToday),
        remainingThisHour: Math.max(0, o.hourlyLimit - sentLastHour),
        awaitingApproval,
        followupsDue,
        strongMatchesWithoutEmail: notFound,
      },
    };
  }

  /** Sent-email log (one row per sent message) with reply tracking. */
  async sentEmails(userId: string, q: { page?: number; pageSize?: number } = {}) {
    const pageSize = Math.min(100, q.pageSize ?? 50);
    const page = Math.max(1, q.page ?? 1);
    const where: Prisma.OutreachWhereInput = { userId, status: 'SENT' };
    const [total, rows] = await Promise.all([
      this.prisma.outreach.count({ where }),
      this.prisma.outreach.findMany({
        where,
        orderBy: { sentAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { root: { select: { threadState: true, repliedAt: true } }, application: { select: { id: true, job: { select: { title: true, company: { select: { name: true } } } } } } },
      }),
    ]);
    return {
      total,
      page,
      pageSize,
      items: rows.map((r) => {
        const thread = r.kind === 'INITIAL' ? r : (r.root ?? r);
        return {
          id: r.id,
          application_id: r.application.id,
          company: r.application.job.company.name,
          role: r.application.job.title,
          kind: r.kind,
          sequence: r.sequence,
          message_id: r.gmailMessageId,
          thread_id: r.gmailThreadId,
          recipient: r.toEmail,
          recipient_domain: emailDomain(r.toEmail),
          subject: r.subject,
          sent_at: r.sentAt,
          status: r.status,
          reply_detected: thread.threadState === 'REPLIED',
          reply_at: thread.repliedAt,
        };
      }),
    };
  }
}
