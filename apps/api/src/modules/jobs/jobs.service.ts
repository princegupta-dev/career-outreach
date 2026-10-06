import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { JobProviderKind, Prisma, Recommendation } from '@prisma/client';
import { AuditService } from '../../common/audit.service';
import { hashObject } from '../../common/crypto';
import { DomainError } from '../../common/http';
import { MetricsService } from '../../common/metrics.service';
import { PrismaService } from '../../common/prisma.service';
import { ENV, Env } from '../../config/env';
import { jobContentHash, jobSourceHash } from '../../domain/dedupe';
import { MatchResult, scoreJob } from '../../domain/matching/scorer';
import { extractJob, JobExtraction, normalizeText, parseSalary } from '../../domain/skills/extract';
import { JobAnalysis } from '../../providers/ai/ai-provider.interface';
import { AshbyProvider, GreenhouseProvider, LeverProvider } from '../../providers/jobs/ats.providers';
import { JobProvider, JobProviderError, JobSearchCriteria, passesBasicFilters, ProviderJob } from '../../providers/jobs/job-provider.interface';
import { UrlJobProvider } from '../../providers/jobs/url.provider';
import { FEED_PROVIDERS } from '../../providers/jobs/aggregators';
import { DEFAULT_EXCLUDE_TITLES, DEFAULT_SOURCES } from '../../providers/jobs/default-sources';
import { ContactsService } from '../contacts/contacts.service';
import { AiService } from '../ai/ai.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { ApplicationsService } from '../applications/applications.service';
import { CompaniesService } from '../companies/companies.service';
import { ProfileService } from '../profile/profile.service';
import { QueueService } from '../queues/queues';
import { SettingsService } from '../settings/settings.service';

export interface IngestResult {
  jobId: string;
  duplicate: boolean;
  score?: number | null;
  recommendation?: Recommendation | null;
}

export interface DiscoveryStats {
  fetched: number;
  afterBasicFilters: number;
  duplicates: number;
  created: number;
  qualified: number;
  queuedForAi: number;
}

export interface ManualJobInput {
  title: string;
  companyName: string;
  description: string;
  location?: string | null;
  url?: string | null;
  companyWebsite?: string | null;
  salaryText?: string | null;
  remote?: boolean | null;
}


@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  readonly providers: JobProvider[] = [new GreenhouseProvider(), new LeverProvider(), new AshbyProvider(), ...FEED_PROVIDERS];
  private readonly urlProvider = new UrlJobProvider();

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly companies: CompaniesService,
    private readonly applications: ApplicationsService,
    private readonly profiles: ProfileService,
    private readonly settings: SettingsService,
    private readonly ai: AiService,
    private readonly queues: QueueService,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
    private readonly analytics: AnalyticsService,
    private readonly contacts: ContactsService,
  ) {}

  providerFor(kind: JobProviderKind): JobProvider | undefined {
    return this.providers.find((p) => p.kind === kind);
  }

  // ─── Ingestion ─────────────────────────────────────────────────────────────

  /** Dedupe → persist → deterministic score. Never calls the LLM directly. */
  async ingest(userId: string, pj: ProviderJob, sourceId?: string): Promise<IngestResult> {
    const description = normalizeText(pj.description);
    if (description.length < 50) throw new DomainError('The job description is too short to analyse (min 50 characters).', 400);
    const sourceHash = jobSourceHash({ provider: pj.provider, externalId: pj.externalId, url: pj.url });
    const contentHash = jobContentHash({ companyName: pj.companyName, title: pj.title, description });

    const dup = await this.prisma.job.findFirst({
      where: { userId, OR: [{ contentHash }, ...(sourceHash ? [{ sourceHash }] : [])] },
      select: { id: true, score: true, recommendation: true, deletedAt: true },
    });
    if (dup) {
      if (dup.deletedAt) await this.prisma.job.update({ where: { id: dup.id }, data: { deletedAt: null } });
      return { jobId: dup.id, duplicate: true, score: dup.score, recommendation: dup.recommendation };
    }

    const company = await this.companies.findOrCreate(userId, pj.companyName, { website: pj.companyWebsite, domain: pj.companyDomain, location: pj.location });
    const salary = parseSalary(pj.salaryText ?? '') ?? parseSalary(description);
    let job;
    try {
      job = await this.prisma.job.create({
        data: {
          userId,
          companyId: company.id,
          sourceId: sourceId ?? null,
          provider: pj.provider,
          externalId: pj.externalId ?? null,
          url: pj.url ?? null,
          title: pj.title.trim().slice(0, 300),
          location: pj.location ?? null,
          remote: pj.remote ?? null,
          employmentType: pj.employmentType ?? null,
          salaryMin: salary?.min ?? null,
          salaryMax: salary?.max ?? null,
          salaryCurrency: salary?.currency ?? null,
          salaryPeriod: salary?.period ?? null,
          description,
          contentHash,
          sourceHash,
          postedAt: pj.postedAt ?? null,
          application: { create: { userId, status: 'DISCOVERED' } },
        },
      });
    } catch (e) {
      // Race with a concurrent ingest of the same job → treat as duplicate.
      if ((e as { code?: string }).code === 'P2002') {
        const existing = await this.prisma.job.findFirst({ where: { userId, contentHash } });
        if (existing) return { jobId: existing.id, duplicate: true, score: existing.score, recommendation: existing.recommendation };
      }
      throw e;
    }
    if (pj.contacts?.length) await this.contacts.upsertCandidates(userId, company.id, pj.contacts);
    const scored = await this.score(job.id);
    await this.analytics.invalidate(userId);
    await this.audit.log('job.created', { userId, entityType: 'job', entityId: job.id, metadata: { provider: pj.provider, score: scored.score } });
    return { jobId: job.id, duplicate: false, score: scored.score, recommendation: scored.recommendation };
  }

  async createManual(userId: string, input: ManualJobInput, kind: JobProviderKind = 'MANUAL'): Promise<IngestResult> {
    const result = await this.ingest(userId, {
      provider: kind,
      title: input.title,
      companyName: input.companyName,
      description: input.description,
      location: input.location,
      url: input.url,
      companyWebsite: input.companyWebsite,
      salaryText: input.salaryText,
      remote: input.remote,
    });
    if (!result.duplicate) await this.maybeQueueAnalysis(userId, result.jobId, result.score ?? 0);
    return result;
  }

  async importFromUrl(userId: string, url: string): Promise<IngestResult> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new DomainError('Invalid URL', 400);
    }
    if (!/^https?:$/.test(parsed.protocol)) throw new DomainError('Only http(s) URLs are supported', 400);
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(parsed.hostname) || parsed.hostname.endsWith('.internal')) {
      throw new DomainError('Private network URLs are not allowed', 400);
    }
    const provider = this.providers.find((p) => p.supportsUrl(url)) ?? this.urlProvider;
    const pj = await provider.getJob(url);
    if (!pj) throw new JobProviderError('Job not found at that URL (it may have been closed).');
    const result = await this.ingest(userId, pj);
    if (!result.duplicate) await this.maybeQueueAnalysis(userId, result.jobId, result.score ?? 0);
    return result;
  }

  // ─── Deterministic processing ──────────────────────────────────────────────

  /** Extract + score. Idempotent: skipped when profile, settings and content are unchanged. */
  async score(jobId: string, force = false): Promise<{ score: number | null; recommendation: Recommendation | null; skipped: boolean }> {
    const job = await this.prisma.job.findUniqueOrThrow({ where: { id: jobId }, include: { company: true, application: true } });
    const profile = await this.profiles.get();
    const settingsHash = await this.settings.hash(job.userId);
    const scoredWith = hashObject({ profile: profile.hash, settings: settingsHash, content: job.contentHash, company: [job.company.size, job.company.companyType], v: 'v3' });
    if (!force && job.scoredWith === scoredWith && job.score != null) return { score: job.score, recommendation: job.recommendation, skipped: true };

    const extraction = extractJob({ title: job.title, description: job.description, location: job.location, companyName: job.company.name });
    if (job.remote === true && extraction.workMode === 'unknown') extraction.workMode = 'remote';
    if (!extraction.salary && job.salaryCurrency) {
      extraction.salary = { min: job.salaryMin, max: job.salaryMax, currency: job.salaryCurrency, period: (job.salaryPeriod as 'year') ?? 'year', raw: '' };
    }
    const match = scoreJob({ title: job.title, location: job.location, companyName: job.company.name, companySize: job.company.size, companyType: job.company.companyType, extraction }, profile);
    await this.prisma.job.update({
      where: { id: jobId },
      data: {
        extracted: extraction as unknown as Prisma.InputJsonValue,
        score: match.total,
        scoreBreakdown: match as unknown as Prisma.InputJsonValue,
        recommendation: match.recommendation,
        scoredWith,
      },
    });
    const settings = await this.settings.get(job.userId);
    if (job.application && match.total >= settings.matching.qualifyScore && match.recommendation !== 'SKIP') {
      await this.applications.autoAdvance(job.application.id, 'QUALIFIED');
    }
    await this.metrics.record('job.processed', { jobId, score: match.total });
    return { score: match.total, recommendation: match.recommendation, skipped: false };
  }

  async rescoreAll(userId: string): Promise<{ rescored: number }> {
    const jobs = await this.prisma.job.findMany({ where: { userId, deletedAt: null }, select: { id: true } });
    let rescored = 0;
    for (const j of jobs) if (!(await this.score(j.id)).skipped) rescored++;
    return { rescored };
  }

  /** Only strong deterministic matches are sent to the LLM. */
  async maybeQueueAnalysis(userId: string, jobId: string, score: number): Promise<boolean> {
    if (!this.ai.usesLlm) return false;
    const settings = await this.settings.get(userId);
    const threshold = Math.max(settings.matching.minScoreForAi, this.env.AI_MIN_SCORE_FOR_ANALYSIS);
    if (!settings.matching.autoAnalyze || score < threshold) return false;
    await this.queues.processJob({ userId, jobId, analyze: true });
    return true;
  }

  // ─── AI analysis (semantic layer) ──────────────────────────────────────────

  async analyze(userId: string, jobId: string, force = false): Promise<{ analysis: JobAnalysis; cached: boolean; provider: string; adjustedScore: number }> {
    const job = await this.prisma.job.findFirst({ where: { id: jobId, userId }, include: { company: true } });
    if (!job) throw new NotFoundException('Job not found');
    if (job.score == null) await this.score(jobId);
    const fresh = await this.prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    const profile = await this.profiles.get();
    const analysisHash = hashObject({ content: job.contentHash, profile: profile.hash });
    const match = fresh.scoreBreakdown as unknown as MatchResult;

    if (!force && fresh.analysisHash === analysisHash && fresh.analysis) {
      const a = fresh.analysis as unknown as JobAnalysis & { provider?: string };
      return { analysis: a, cached: true, provider: a.provider ?? 'cache', adjustedScore: clampScore(match.total + (a.scoreAdjustment ?? 0)) };
    }
    const result = await this.ai.run(
      userId,
      'JOB_ANALYSIS',
      { analysisHash, score: match.total },
      (p) => p.analyzeJob({ profile, jobTitle: job.title, companyName: job.company.name, description: job.description, match }),
      { force },
    );
    const analysis = { ...result.output, provider: result.provider, fallback: result.fallback };
    await this.prisma.job.update({ where: { id: jobId }, data: { analysis: analysis as unknown as Prisma.InputJsonValue, analysisHash } });
    return { analysis: result.output, cached: result.cached, provider: result.provider, adjustedScore: clampScore(match.total + result.output.scoreAdjustment) };
  }

  // ─── Discovery ─────────────────────────────────────────────────────────────

  async criteriaFor(userId?: string): Promise<JobSearchCriteria & { allowRelocation: boolean }> {
    const profile = await this.profiles.get();
    const fromRoles = profile.target_roles.flatMap((r) => r.toLowerCase().replace(/^(senior|sr\.?)\s+/, '').split(/\s*\/\s*/));
    const titleKeywords = [...new Set([...fromRoles, 'backend', 'back-end', 'back end', 'node', 'typescript', 'platform', 'software engineer', 'software developer', 'sde', 'server', 'full stack', 'fullstack', 'api'])];
    // Never exclude a stack the candidate actually has.
    const own = profile.strongSkills.map((x) => x.toLowerCase());
    const exclude = DEFAULT_EXCLUDE_TITLES.filter((k) => !own.includes(k.trim()));
    const maxAge = userId ? (await this.settings.get(userId)).discovery.maxAgeDays : 30;
    return {
      titleKeywords,
      excludeTitleKeywords: exclude,
      locations: profile.target_locations.filter((l) => l.toLowerCase() !== 'remote'),
      includeRemote: profile.target_locations.some((l) => l.toLowerCase() === 'remote'),
      allowRelocation: profile.open_to_relocation,
      postedWithinDays: maxAge,
      limit: 500,
    };
  }

  /** Seed the curated boards + public feeds so discovery works with zero setup. */
  async ensureDefaultSources(userId: string): Promise<number> {
    const r = await this.prisma.jobSource.createMany({
      data: DEFAULT_SOURCES.map((d) => ({ userId, provider: d.provider, name: d.name, config: d.config as Prisma.InputJsonValue, isDefault: true })),
      skipDuplicates: true,
    });
    return r.count;
  }

  /**
   * Discovery pipeline for one source:
   *   fetch → basic title/location filters → dedupe → deterministic score → (strong only) AI queue.
   */
  async runSource(userId: string, sourceId: string): Promise<DiscoveryStats> {
    const source = await this.prisma.jobSource.findFirst({ where: { id: sourceId, userId } });
    if (!source) throw new NotFoundException('Job source not found');
    const provider = this.providerFor(source.provider);
    if (!provider) throw new DomainError(`Provider ${source.provider} does not support discovery`, 400);
    const criteria = await this.criteriaFor(userId);
    const stats: DiscoveryStats = { fetched: 0, afterBasicFilters: 0, duplicates: 0, created: 0, qualified: 0, queuedForAi: 0 };
    const config = source.config as Record<string, unknown>;
    try {
      const counter = { fetched: 0 };
      const all = (await provider.searchJobs({ ...criteria, stats: counter }, config)).map((j) => ({
        ...j,
        companyDomain: j.companyDomain ?? (typeof config.domain === 'string' ? config.domain : null),
        companyName: typeof config.companyName === 'string' && ['GREENHOUSE', 'LEVER', 'ASHBY'].includes(source.provider) ? config.companyName : j.companyName,
      }));
      stats.fetched = Math.max(counter.fetched, all.length);
      const filtered = all.filter((j) => passesBasicFilters(j, criteria));
      stats.afterBasicFilters = filtered.length;
      const settings = await this.settings.get(userId);
      for (const pj of filtered) {
        if (normalizeText(pj.description).length < 50) continue;
        try {
          const r = await this.ingest(userId, pj, source.id);
          if (r.duplicate) {
            stats.duplicates++;
            continue;
          }
          stats.created++;
          if ((r.score ?? 0) >= settings.matching.qualifyScore) stats.qualified++;
          if (await this.maybeQueueAnalysis(userId, r.jobId, r.score ?? 0)) stats.queuedForAi++;
        } catch (e) {
          await this.metrics.record('job.processing_failure', { sourceId, error: (e as Error).message });
        }
      }
      await this.prisma.jobSource.update({ where: { id: source.id }, data: { lastRunAt: new Date(), lastError: null, lastCount: stats.created, lastStats: stats as unknown as Prisma.InputJsonValue } });
      this.logger.log({ msg: 'Discovery finished', sourceId, ...stats });
      return stats;
    } catch (e) {
      await this.prisma.jobSource.update({ where: { id: source.id }, data: { lastRunAt: new Date(), lastError: (e as Error).message.slice(0, 500) } });
      throw e;
    }
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  async list(
    userId: string,
    q: { search?: string; status?: string; recommendation?: string; minScore?: number; sort?: 'score' | 'recent'; page?: number; pageSize?: number },
  ) {
    const where: Prisma.JobWhereInput = {
      userId,
      deletedAt: null,
      ...(q.minScore != null ? { score: { gte: q.minScore } } : {}),
      ...(q.recommendation ? { recommendation: q.recommendation as Recommendation } : {}),
      ...(q.status ? { application: { status: q.status as Prisma.EnumApplicationStatusFilter['equals'] } } : {}),
      ...(q.search
        ? {
            OR: [
              { title: { contains: q.search, mode: 'insensitive' } },
              { company: { name: { contains: q.search, mode: 'insensitive' } } },
              { location: { contains: q.search, mode: 'insensitive' } },
              { description: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const pageSize = Math.min(100, q.pageSize ?? 25);
    const page = Math.max(1, q.page ?? 1);
    const [total, items] = await Promise.all([
      this.prisma.job.count({ where }),
      this.prisma.job.findMany({
        where,
        orderBy: q.sort === 'recent' ? { createdAt: 'desc' } : [{ score: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          title: true,
          location: true,
          remote: true,
          url: true,
          score: true,
          recommendation: true,
          salaryMin: true,
          salaryMax: true,
          salaryCurrency: true,
          salaryPeriod: true,
          createdAt: true,
          provider: true,
          company: { select: { id: true, name: true, size: true } },
          application: { select: { id: true, status: true, contact: { select: { id: true, name: true, role: true, email: true } } } },
        },
      }),
    ]);
    return { total, page, pageSize, items: items.map((j) => ({ ...j, nextAction: j.application ? this.applications.nextAction(j.application.status) : null })) };
  }

  async get(userId: string, jobId: string) {
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, userId, deletedAt: null },
      include: {
        company: { include: { contacts: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } } } },
        application: {
          include: {
            contact: true,
            outreach: { orderBy: [{ sequence: 'asc' }], include: { followups: { orderBy: { sequence: 'asc' } }, events: { orderBy: { occurredAt: 'asc' } } } },
          },
        },
        resumeVersions: { orderBy: { createdAt: 'desc' }, take: 5, omit: { pdf: true, latex: true, data: true } },
        source: { select: { id: true, name: true, provider: true } },
      },
    });
    if (!job) throw new NotFoundException('Job not found');
    return { ...job, extracted: job.extracted as unknown as JobExtraction | null, nextAction: job.application ? this.applications.nextAction(job.application.status) : null };
  }

  async remove(userId: string, jobId: string): Promise<void> {
    const job = await this.prisma.job.findFirst({ where: { id: jobId, userId } });
    if (!job) throw new NotFoundException('Job not found');
    await this.prisma.job.update({ where: { id: jobId }, data: { deletedAt: new Date() } });
    await this.audit.log('job.deleted', { userId, entityType: 'job', entityId: jobId });
  }
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}
