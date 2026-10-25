import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ApplicationStatus, CompanySize, JobProviderKind, Prisma, Recommendation } from '@prisma/client';
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
import { assessEligibility, Eligibility, JobProvider, JobProviderError, JobSearchCriteria, passesBasicFilters, ProviderJob, SearchStats } from '../../providers/jobs/job-provider.interface';
import { UrlJobProvider } from '../../providers/jobs/url.provider';
import { JobSummary, RECOMMENDATIONS_OF, summarizeJob, VERDICT_LABEL, Verdict, verdictFor } from './job-summary';
import { lifecycleOf, Stage, statusesOfStage } from '../../domain/applications/lifecycle';
import { FEED_PROVIDERS } from '../../providers/jobs/aggregators';
import { DEFAULT_EXCLUDE_TITLES, DEFAULT_SOURCES, FLAG_TITLES } from '../../providers/jobs/default-sources';
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
  /** New jobs kept although the region is not stated (eligibility UNCERTAIN). */
  uncertain: number;
  /** Why postings were dropped by the hard eligibility rules (reason code → count). */
  rejected: Record<string, number>;
  /** Passed the filters but unusable (description missing or too short). */
  invalid: number;
  /** Passed the filters but could not be saved. */
  failed: number;
  /** Partial problems that did not fail the source (a feed page or job detail that could not be read, ...). */
  warnings: string[];
  /** First few save errors, for diagnosis. */
  failures: string[];
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

  /**
   * Dedupe → persist → deterministic score. Never calls the LLM directly.
   * A job the user deleted stays deleted when discovery finds it again; only an explicit
   * manual import (`restoreDeleted`) brings it back.
   */
  async ingest(userId: string, pj: ProviderJob, sourceId?: string, opts: { restoreDeleted?: boolean; eligibility?: Eligibility } = {}): Promise<IngestResult> {
    const description = normalizeText(pj.description);
    if (description.length < 50) throw new DomainError('The job description is too short to analyse (min 50 characters).', 400);
    const sourceHash = jobSourceHash({ provider: pj.provider, externalId: pj.externalId, url: pj.url });
    const contentHash = jobContentHash({ companyName: pj.companyName, title: pj.title, description });

    const dup = await this.prisma.job.findFirst({
      where: { userId, OR: [{ contentHash }, ...(sourceHash ? [{ sourceHash }] : [])] },
      select: { id: true, score: true, recommendation: true, deletedAt: true },
    });
    if (dup) {
      if (dup.deletedAt && opts.restoreDeleted) await this.prisma.job.update({ where: { id: dup.id }, data: { deletedAt: null } });
      return { jobId: dup.id, duplicate: true, score: dup.score, recommendation: dup.recommendation };
    }

    const company = await this.companies.findOrCreate(userId, pj.companyName, { website: pj.companyWebsite, domain: pj.companyDomain, location: pj.location, meta: pj.companyMeta });
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
          postedAt: pj.postedAt && !isNaN(pj.postedAt.getTime()) ? pj.postedAt : null,
          eligibility: opts.eligibility?.status ?? 'ELIGIBLE',
          eligibilityFlags: opts.eligibility?.flags ?? [],
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
    const result = await this.ingest(
      userId,
      {
        provider: kind,
        title: input.title,
        companyName: input.companyName,
        description: input.description,
        location: input.location,
        url: input.url,
        companyWebsite: input.companyWebsite,
        salaryText: input.salaryText,
        remote: input.remote,
      },
      undefined,
      { restoreDeleted: true },
    );
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
    const result = await this.ingest(userId, pj, undefined, { restoreDeleted: true });
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

  /**
   * Hard eligibility only: an engineering role, the right function and level, and a location open to India.
   * Everything else (seniority above senior, stack mismatch, unstated region, age) is kept as a flag for the ranker.
   */
  async criteriaFor(userId?: string): Promise<JobSearchCriteria & { allowRelocation: boolean }> {
    const profile = await this.profiles.get();
    // Never exclude or flag a stack the candidate actually has, or a word from their own target roles
    // (e.g. "Frontend Engineer" or "Staff Engineer" must not be filtered out by the defaults).
    const own = profile.strongSkills.map((x) => x.toLowerCase());
    const fromRoles = profile.target_roles.map((r) => r.toLowerCase());
    const keep = (k: string) => !own.includes(k.trim()) && !fromRoles.some((r) => ` ${r} `.includes(` ${k.trim()} `));
    const exclude = DEFAULT_EXCLUDE_TITLES.filter(keep);
    const flags = Object.fromEntries(Object.entries(FLAG_TITLES).map(([flag, kws]) => [flag, kws.filter(keep)]));
    const maxAge = userId ? (await this.settings.get(userId)).discovery.maxAgeDays : 30;
    return {
      titleKeywords: [],
      requireEngineering: true,
      excludeTitleKeywords: exclude,
      flagTitleKeywords: flags,
      locations: profile.target_locations.filter((l) => l.toLowerCase() !== 'remote'),
      includeRemote: profile.target_locations.some((l) => l.toLowerCase() === 'remote'),
      allowRelocation: profile.open_to_relocation,
      postedWithinDays: maxAge,
      staleAfterDays: maxAge,
      limit: 2000,
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
    const base = await this.criteriaFor(userId);
    // Company boards list only open roles, so the posting age is a flag there, not a reason to drop.
    const criteria = ['GREENHOUSE', 'LEVER', 'ASHBY'].includes(source.provider) ? { ...base, postedWithinDays: undefined } : base;
    const stats: DiscoveryStats = { fetched: 0, afterBasicFilters: 0, duplicates: 0, created: 0, qualified: 0, queuedForAi: 0, uncertain: 0, rejected: {}, invalid: 0, failed: 0, warnings: [], failures: [] };
    const config = source.config as Record<string, unknown>;
    try {
      const counter: SearchStats = { fetched: 0, rejected: {}, warnings: [] };
      const all = (await provider.searchJobs({ ...criteria, stats: counter }, config)).map((j) => ({
        ...j,
        companyMeta: j.companyMeta ?? companyMetaFromConfig(config),
        companyDomain: j.companyDomain ?? (typeof config.domain === 'string' ? config.domain : null),
        companyName: typeof config.companyName === 'string' && ['GREENHOUSE', 'LEVER', 'ASHBY'].includes(source.provider) ? config.companyName : j.companyName,
      }));
      stats.fetched = Math.max(counter.fetched, all.length);
      stats.rejected = counter.rejected ?? {};
      stats.warnings = counter.warnings ?? [];
      const filtered = all.filter((j) => passesBasicFilters(j, criteria));
      stats.afterBasicFilters = filtered.length;
      const settings = await this.settings.get(userId);
      for (const pj of filtered) {
        if (normalizeText(pj.description).length < 50) {
          stats.invalid++;
          continue;
        }
        try {
          const eligibility = assessEligibility(pj, criteria);
          const r = await this.ingest(userId, pj, source.id, { eligibility });
          if (r.duplicate) {
            stats.duplicates++;
            continue;
          }
          stats.created++;
          if (eligibility.status === 'UNCERTAIN') stats.uncertain++;
          if ((r.score ?? 0) >= settings.matching.qualifyScore) stats.qualified++;
          if (await this.maybeQueueAnalysis(userId, r.jobId, r.score ?? 0)) stats.queuedForAi++;
        } catch (e) {
          stats.failed++;
          if (stats.failures.length < 5) stats.failures.push(`${pj.title.slice(0, 80)}: ${(e as Error).message.slice(0, 160)}`);
          await this.metrics.record('job.processing_failure', { sourceId, title: pj.title, error: (e as Error).message });
        }
      }
      await this.prisma.jobSource.update({ where: { id: source.id }, data: { lastRunAt: new Date(), lastSuccessAt: new Date(), consecutiveFailures: 0, lastError: null, lastCount: stats.created, lastStats: stats as unknown as Prisma.InputJsonValue } });
      this.logger.log({ msg: 'Discovery finished', sourceId, ...stats });
      return stats;
    } catch (e) {
      await this.prisma.jobSource.update({ where: { id: source.id }, data: { lastRunAt: new Date(), lastError: (e as Error).message.slice(0, 500), consecutiveFailures: { increment: 1 } } });
      throw e;
    }
  }

  /** Verdict, facts (unknowns marked) and the three short lists for the job page. */
  summary(job: Prisma.JobGetPayload<{ include: { company: true } }>): JobSummary {
    return summarizeJob({
      title: job.title,
      location: job.location,
      remote: job.remote,
      score: job.score,
      recommendation: job.recommendation,
      scoreBreakdown: job.scoreBreakdown as unknown as MatchResult | null,
      extracted: job.extracted as unknown as JobExtraction | null,
      eligibility: job.eligibility,
      eligibilityFlags: job.eligibilityFlags,
      salaryMin: job.salaryMin,
      salaryMax: job.salaryMax,
      postedAt: job.postedAt,
      company: { size: job.company.size, teamSize: job.company.teamSize, provenance: job.company.provenance },
    });
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  /**
   * Compact job list. With `sort: 'priority'` (or `needsAction`) jobs waiting for the user come first
   * (replies, approvals, input, shortlisted…), then by match. That order depends on the application's
   * status and workflow, so it is computed over the matching jobs' light rows and then paged.
   */
  async list(
    userId: string,
    q: {
      search?: string;
      status?: string;
      stage?: Stage;
      recommendation?: string;
      verdict?: Verdict;
      source?: string;
      location?: 'remote' | 'india' | 'other';
      companySize?: string;
      needsAction?: boolean;
      minScore?: number;
      sort?: 'score' | 'recent' | 'priority';
      page?: number;
      pageSize?: number;
    },
  ) {
    const statusIn = q.status ? [q.status as ApplicationStatus] : q.stage ? statusesOfStage(q.stage) : null;
    const INDIA = ['india', 'bengaluru', 'bangalore', 'gurugram', 'gurgaon', 'noida', 'delhi', 'pune', 'hyderabad', 'mumbai', 'chennai'];
    const contains = (v: string) => ({ location: { contains: v, mode: 'insensitive' as const } });
    const locationFilter: Prisma.JobWhereInput[] =
      q.location === 'remote'
        ? [{ OR: [{ remote: true }, contains('remote')] }]
        : q.location === 'india'
          ? [{ OR: INDIA.map(contains) }]
          : q.location === 'other'
            ? [{ OR: [{ remote: false }, { remote: null }] }, { location: { not: null } }, { NOT: [contains('remote'), ...INDIA.map(contains)] }]
            : [];
    const where: Prisma.JobWhereInput = {
      userId,
      deletedAt: null,
      ...(q.minScore != null ? { score: { gte: q.minScore } } : {}),
      ...(q.recommendation ? { recommendation: q.recommendation as Recommendation } : q.verdict ? { recommendation: { in: RECOMMENDATIONS_OF[q.verdict] } } : {}),
      ...(statusIn ? { application: { status: { in: statusIn } } } : {}),
      ...(q.source ? { provider: q.source as JobProviderKind } : {}),
      ...(q.companySize ? { company: { size: q.companySize as CompanySize } } : {}),
      ...(locationFilter.length ? { AND: locationFilter } : {}),
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
    const select = {
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
      eligibility: true,
      eligibilityFlags: true,
      company: { select: { id: true, name: true, size: true, teamSize: true, category: true } },
      application: { select: { id: true, status: true, contact: { select: { id: true, name: true, role: true, email: true } }, workflow: { select: { status: true, mode: true } } } },
    } satisfies Prisma.JobSelect;

    let total: number;
    let items: Array<Prisma.JobGetPayload<{ select: typeof select }>>;
    if (q.sort === 'priority' || q.needsAction) {
      const light = await this.prisma.job.findMany({
        where,
        select: { id: true, score: true, createdAt: true, recommendation: true, application: { select: { status: true, workflow: { select: { status: true, mode: true } } } } },
      });
      const ranked = light
        .map((j) => ({ id: j.id, score: j.score ?? -1, createdAt: j.createdAt.getTime(), act: j.application ? lifecycleOf(j.application.status, { recommendation: j.recommendation, workflow: j.application.workflow }) : null }))
        .filter((r) => !q.needsAction || r.act?.needsAction)
        .sort((a, b) => (a.act?.priority ?? 9) - (b.act?.priority ?? 9) || b.score - a.score || b.createdAt - a.createdAt);
      total = ranked.length;
      const ids = ranked.slice((page - 1) * pageSize, page * pageSize).map((r) => r.id);
      const rows = await this.prisma.job.findMany({ where: { id: { in: ids } }, select });
      const byId = new Map(rows.map((r) => [r.id, r]));
      items = ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
    } else {
      [total, items] = await Promise.all([
        this.prisma.job.count({ where }),
        this.prisma.job.findMany({
          where,
          orderBy: q.sort === 'recent' ? { createdAt: 'desc' } : [{ score: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select,
        }),
      ]);
    }
    return {
      total,
      page,
      pageSize,
      items: items.map((j) => ({
        ...j,
        nextAction: j.application ? this.applications.nextAction(j.application.status) : null,
        lifecycle: j.application ? lifecycleOf(j.application.status, { recommendation: j.recommendation, workflow: j.application.workflow }) : null,
        verdict: { key: verdictFor(j.recommendation), label: VERDICT_LABEL[verdictFor(j.recommendation)] },
      })),
    };
  }

  async get(userId: string, jobId: string) {
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, userId, deletedAt: null },
      include: {
        company: { include: { contacts: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } } } },
        application: {
          include: {
            contact: true,
            workflow: { select: { status: true, mode: true } },
            outreach: { orderBy: [{ sequence: 'asc' }], include: { followups: { orderBy: { sequence: 'asc' } }, events: { orderBy: { occurredAt: 'asc' } } } },
          },
        },
        resumeVersions: { orderBy: { createdAt: 'desc' }, take: 5, omit: { pdf: true, latex: true, data: true } },
        source: { select: { id: true, name: true, provider: true } },
      },
    });
    if (!job) throw new NotFoundException('Job not found');
    return {
      ...job,
      extracted: job.extracted as unknown as JobExtraction | null,
      nextAction: job.application ? this.applications.nextAction(job.application.status) : null,
      lifecycle: job.application ? lifecycleOf(job.application.status, { recommendation: job.recommendation, workflow: job.application.workflow }) : null,
      summary: this.summary(job),
    };
  }

  async remove(userId: string, jobId: string): Promise<void> {
    const job = await this.prisma.job.findFirst({ where: { id: jobId, userId } });
    if (!job) throw new NotFoundException('Job not found');
    await this.prisma.job.update({ where: { id: jobId }, data: { deletedAt: new Date() } });
    await this.audit.log('job.deleted', { userId, entityType: 'job', entityId: jobId });
  }
}

/** Facts a directory-discovered source carries in its config (see DirectoryService). */
function companyMetaFromConfig(config: Record<string, unknown>) {
  const teamSize = typeof config.teamSize === 'number' ? config.teamSize : null;
  const category = typeof config.category === 'string' ? config.category : null;
  const careerUrl = typeof config.careerUrl === 'string' ? config.careerUrl : null;
  const provenance = config.provenance && typeof config.provenance === 'object' ? (config.provenance as Record<string, unknown>) : null;
  return teamSize || category || careerUrl || provenance ? { teamSize, category, careerUrl, provenance } : undefined;
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}
