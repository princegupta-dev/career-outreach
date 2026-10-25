import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { MetricsService } from '../../common/metrics.service';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import { startOfLocalDay } from '../../domain/outreach/guardrails';
import { AiService } from '../ai/ai.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { ContactsService } from '../contacts/contacts.service';
import { DirectoryResult, DirectoryService } from './directory.service';
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
  /** Relevant jobs at companies that look like startups (≤ 300 people, or sized early/growth stage). */
  relevantStartups: number;
  queuedForAi: number;
  /** New jobs kept although their region is not stated (flagged, ranked lower, never silently dropped). */
  uncertain: number;
  /** Sources not run this time because they failed 5+ times in a row recently. */
  sourcesSkipped: number;
  /** What the startup directory contributed (companies seen, probed, boards found, sources added). */
  directory?: DirectoryResult;
  prepared: number;
  /** Postings dropped by the title/region/age filters, by reason code, across all sources. */
  rejected: Record<string, number>;
  /** Passed the filters but unusable (no/short description). */
  invalid: number;
  /** Passed the filters but could not be saved. */
  failed: number;
  /** Partial problems that did not fail a source. */
  warnings: Array<{ source: string; warning: string }>;
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
    private readonly directory: DirectoryService,
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
      // Find more startups to watch (bounded work per run; a failure here never blocks the sources we already have).
      stats.directory = await this.directory.refresh(userId);
      for (const w of stats.directory.warnings) stats.warnings.push({ source: 'Startup directory', warning: w });
      const enabled = await this.prisma.jobSource.findMany({ where: { userId, enabled: true }, orderBy: { createdAt: 'asc' } });
      // A source that failed 5+ times in a row is retried at most once a day, so it cannot slow every run.
      const dayAgo = Date.now() - 24 * 3600_000;
      const sources = enabled.filter((x) => x.consecutiveFailures < 5 || !x.lastRunAt || x.lastRunAt.getTime() < dayAgo);
      stats.sourcesSkipped = enabled.length - sources.length;
      if (stats.sourcesSkipped) stats.warnings.push({ source: 'Source health', warning: `${stats.sourcesSkipped} sources skipped after repeated failures (retried daily)` });
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
            stats.uncertain += r.uncertain;
            stats.invalid += r.invalid;
            stats.failed += r.failed;
            for (const [reason, n] of Object.entries(r.rejected)) stats.rejected[reason] = (stats.rejected[reason] ?? 0) + n;
            for (const w of r.warnings) stats.warnings.push({ source: s.name, warning: w.slice(0, 300) });
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
      stats.relevantStartups = await this.prisma.job.count({
        where: {
          userId,
          deletedAt: null,
          createdAt: { gte: run.startedAt },
          recommendation: { in: [...RELEVANT] },
          company: { OR: [{ teamSize: { gte: 5, lte: 300 } }, { teamSize: null, size: { in: ['EARLY_STARTUP', 'GROWTH_STARTUP'] } }] },
        },
      });
      stats.prepared = (await this.prepareTop(userId)).prepared;
      return { runId: run.id, ...stats };
    } finally {
      await this.prisma.discoveryRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), stats: stats as unknown as Prisma.InputJsonValue } });
      await this.analytics.invalidate(userId);
      await release();
      this.logger.log({ msg: 'Discovery run finished', userId, trigger, ...stats, errors: stats.errors.length, warnings: stats.warnings.length });
    }
  }

  /**
   * Prepare outreach for the best new matches (daily limit): find a contact,
   * tailor the resume, write the email and mirror it into Gmail Drafts.
   */
  async prepareTop(userId: string): Promise<{ prepared: number; considered: number }> {
    const s = await this.settings.get(userId);
    if (!s.automation.autoPrepare || s.automation.dailyPrepareLimit <= 0) return { prepared: 0, considered: 0 };
    const dayStart = startOfLocalDay(new Date(), s.timezone);
    const already = await this.prisma.application.count({ where: { userId, autoPreparedAt: { gte: dayStart } } });
    let remaining = s.automation.dailyPrepareLimit - already;
    if (remaining <= 0) return { prepared: 0, considered: 0 };
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
          await this.outreach.generateInitial(userId, appId);
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
    return { prepared, considered: candidates.length };
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
  return { sources: 0, sourcesFailed: 0, fetched: 0, afterFilters: 0, duplicates: 0, created: 0, relevant: 0, relevantStartups: 0, queuedForAi: 0, uncertain: 0, sourcesSkipped: 0, prepared: 0, rejected: {}, invalid: 0, failed: 0, warnings: [], errors: [] };
}
