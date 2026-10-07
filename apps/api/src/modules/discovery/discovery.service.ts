import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { MetricsService } from '../../common/metrics.service';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import { startOfLocalDay } from '../../domain/outreach/guardrails';
import { AiService } from '../ai/ai.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { ContactsService } from '../contacts/contacts.service';
import { JobsService } from '../jobs/jobs.service';
import { OutreachService } from '../outreach/outreach.service';
import { ResumeService } from '../resume/resume.service';
import { SettingsService } from '../settings/settings.service';

export interface RunStats {
  sources: number;
  sourcesFailed: number;
  fetched: number;
  afterFilters: number;
  duplicates: number;
  created: number;
  relevant: number;
  queuedForAi: number;
  prepared: number;
  errors: Array<{ source: string; error: string }>;
}

/** "Relevant" = worth acting on. CONSIDER is reported separately. */
const RELEVANT = ['STRONG_APPLY', 'APPLY'] as const;
const CONCURRENCY = 4;

/**
 * The autonomous daily pipeline:
 *   all sources → filters → dedupe → deterministic score → (strong only) AI
 *   → for the day's best N: contact → tailored resume (PDF) → email draft (+ Gmail draft).
 * Nothing is ever sent without approval.
 */
@Injectable()
export class DiscoveryService {
  private readonly logger = new Logger(DiscoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly jobs: JobsService,
    private readonly contacts: ContactsService,
    private readonly resumes: ResumeService,
    private readonly outreach: OutreachService,
    private readonly settings: SettingsService,
    private readonly ai: AiService,
    private readonly analytics: AnalyticsService,
    private readonly metrics: MetricsService,
  ) {}

  async runAll(userId: string, trigger: 'schedule' | 'manual' | 'startup' | 'signup'): Promise<RunStats & { runId: string; skipped?: boolean }> {
    const release = await this.redis.acquireLock(`discovery:${userId}`, 30 * 60_000);
    if (!release) {
      const running = await this.prisma.discoveryRun.findFirst({ where: { userId, finishedAt: null }, orderBy: { startedAt: 'desc' } });
      return { runId: running?.id ?? '', skipped: true, ...emptyStats() };
    }
    const stats = emptyStats();
    const run = await this.prisma.discoveryRun.create({ data: { userId, trigger } });
    try {
      const settings = await this.settings.get(userId);
      if (!settings.discovery.enabled && trigger === 'schedule') return { runId: run.id, skipped: true, ...stats };
      await this.jobs.ensureDefaultSources(userId);
      const sources = await this.prisma.jobSource.findMany({ where: { userId, enabled: true }, orderBy: { createdAt: 'asc' } });
      stats.sources = sources.length;
      const queue = [...sources];
      const worker = async () => {
        for (let s = queue.shift(); s; s = queue.shift()) {
          try {
            const r = await this.jobs.runSource(userId, s.id);
            stats.fetched += r.fetched;
            stats.afterFilters += r.afterBasicFilters;
            stats.duplicates += r.duplicates;
            stats.created += r.created;
            stats.queuedForAi += r.queuedForAi;
          } catch (e) {
            stats.sourcesFailed++;
            stats.errors.push({ source: s.name, error: (e as Error).message.slice(0, 200) });
          }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      stats.relevant = await this.prisma.job.count({
        where: { userId, deletedAt: null, createdAt: { gte: run.startedAt }, recommendation: { in: [...RELEVANT] } },
      });
      stats.prepared = (await this.prepareTop(userId)).prepared;
      return { runId: run.id, ...stats };
    } finally {
      await this.prisma.discoveryRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), stats: stats as unknown as Prisma.InputJsonValue } });
      await this.analytics.invalidate(userId);
      await release();
      this.logger.log({ msg: 'Discovery run finished', userId, trigger, ...stats, errors: stats.errors.length });
    }
  }

  /**
   * Prepare outreach for the best new matches (daily limit): find a contact,
   * tailor the resume, write the email and mirror it into Gmail Drafts.
   */
  async prepareTop(userId: string): Promise<{ prepared: number; considered: number; autoApproved: number }> {
    const stats = { autoApproved: 0 };
    const s = await this.settings.get(userId);
    if (!s.automation.autoPrepare || s.automation.dailyPrepareLimit <= 0) return { prepared: 0, considered: 0, autoApproved: 0 };
    const dayStart = startOfLocalDay(new Date(), s.timezone);
    const already = await this.prisma.application.count({ where: { userId, autoPreparedAt: { gte: dayStart } } });
    let remaining = s.automation.dailyPrepareLimit - already;
    if (remaining <= 0) return { prepared: 0, considered: 0, autoApproved: 0 };
    const candidates = await this.prisma.job.findMany({
      where: {
        userId,
        deletedAt: null,
        score: { gte: s.automation.minScoreToPrepare },
        recommendation: { in: ['STRONG_APPLY', 'APPLY'] },
        createdAt: { gte: new Date(Date.now() - 14 * 86_400_000) },
        application: { autoPreparedAt: null, status: { in: ['DISCOVERED', 'QUALIFIED', 'SHORTLISTED', 'CONTACT_FOUND', 'RESUME_READY'] } },
      },
      orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
      take: remaining * 4,
      include: { application: true },
    });
    let prepared = 0;
    for (const job of candidates) {
      if (remaining <= 0) break;
      const appId = job.application!.id;
      try {
        await this.contacts.discover(userId, job.id);
        await this.resumes.tailor(userId, job.id, { useAi: this.ai.usesLlm });
        const app = await this.prisma.application.findUniqueOrThrow({ where: { id: appId }, include: { contact: true } });
        if (app.contact?.email) {
          const draft = await this.outreach.generateInitial(userId, appId);
          // AUTO_SEND only (never the default): strong match + publicly listed/verified address.
          if (await this.outreach.autoApproveIfAllowed(userId, draft.id)) stats.autoApproved++;
        }
        await this.prisma.application.update({ where: { id: appId }, data: { autoPreparedAt: new Date() } });
        prepared++;
        remaining--;
      } catch (e) {
        await this.metrics.record('job.processing_failure', { stage: 'auto_prepare', jobId: job.id, error: (e as Error).message });
        // Mark it so a broken job isn't retried every run; the user can still prepare it manually.
        await this.prisma.application.update({ where: { id: appId }, data: { autoPreparedAt: new Date(), notes: `Auto-prepare failed: ${(e as Error).message.slice(0, 200)}` } });
      }
    }
    return { prepared, considered: candidates.length, autoApproved: stats.autoApproved };
  }

  /** "We found X relevant jobs for you today." */
  async today(userId: string) {
    const s = await this.settings.get(userId);
    const dayStart = startOfLocalDay(new Date(), s.timezone);
    const where = { userId, deletedAt: null, createdAt: { gte: dayStart }, recommendation: { in: [...RELEVANT] } };
    const [relevant, strong, consider, jobs, lastRun, running, sources, readyToSend] = await Promise.all([
      this.prisma.job.count({ where }),
      this.prisma.job.count({ where: { ...where, recommendation: 'STRONG_APPLY' } }),
      this.prisma.job.count({ where: { ...where, recommendation: 'CONSIDER' } }),
      this.prisma.job.findMany({
        where: { ...where, recommendation: { in: ['STRONG_APPLY', 'APPLY', 'CONSIDER'] } },
        orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
        take: 30,
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
          provider: true,
          url: true,
          createdAt: true,
          company: { select: { name: true } },
          application: {
            select: {
              id: true,
              status: true,
              autoPreparedAt: true,
              contact: { select: { name: true, role: true } },
              outreach: { where: { kind: 'INITIAL' }, select: { id: true, status: true, gmailDraftId: true }, take: 1 },
            },
          },
        },
      }),
      this.prisma.discoveryRun.findFirst({ where: { userId, finishedAt: { not: null } }, orderBy: { startedAt: 'desc' } }),
      this.prisma.discoveryRun.findFirst({ where: { userId, finishedAt: null, startedAt: { gte: new Date(Date.now() - 30 * 60_000) } }, orderBy: { startedAt: 'desc' } }),
      this.prisma.jobSource.count({ where: { userId, enabled: true } }),
      this.prisma.outreach.count({ where: { userId, kind: 'INITIAL', status: 'DRAFT', createdAt: { gte: dayStart } } }),
    ]);
    return {
      relevant,
      strong,
      consider,
      readyToSend,
      sources,
      running: !!running,
      lastRun: lastRun ? { at: lastRun.finishedAt, trigger: lastRun.trigger, stats: lastRun.stats } : null,
      jobs,
    };
  }

  /** True if no run finished in the last `hours` (used on worker start-up). */
  async isStale(userId: string, hours = 20): Promise<boolean> {
    const last = await this.prisma.discoveryRun.findFirst({ where: { userId, startedAt: { gte: new Date(Date.now() - hours * 3600_000) } } });
    return !last;
  }
}

function emptyStats(): RunStats {
  return { sources: 0, sourcesFailed: 0, fetched: 0, afterFilters: 0, duplicates: 0, created: 0, relevant: 0, queuedForAi: 0, prepared: 0, errors: [] };
}
