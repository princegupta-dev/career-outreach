import * as fs from 'fs';
import * as path from 'path';
import { sizeFromTeam } from './domain/company-size';
import { jobContentHash, jobSourceHash } from './domain/dedupe';
import { scoreJob, MatchResult } from './domain/matching/scorer';
import { CandidateProfile, parseProfileMarkdown } from './domain/profile/profile';
import { extractJob, normalizeText } from './domain/skills/extract';
import { AshbyProvider, GreenhouseProvider, LeverProvider } from './providers/jobs/ats.providers';
import { WorkdayProvider } from './providers/jobs/workday';
import { DEFAULT_EXCLUDE_TITLES, DEFAULT_SOURCES, DefaultSource, FLAG_TITLES } from './providers/jobs/default-sources';
import { assessEligibility, JobProvider, JobSearchCriteria, passesBasicFilters, ProviderJob, SearchStats } from './providers/jobs/job-provider.interface';
import { indiaCompanySources } from './india-companies';
import { startupSources } from './startups';
import type { ContactCandidate } from './types';

/** One job, ready to show. `id` is stable across runs, so the browser can remember what it has already seen. */
export interface FoundJob {
  id: string;
  title: string;
  company: string;
  companyDomain: string | null;
  location: string | null;
  remote: boolean | null;
  url: string | null;
  postedAt: string | null;
  source: string;
  salaryText: string | null;
  teamSize: number | null;
  score: number;
  recommendation: MatchResult['recommendation'];
  reasons: string[];
  missingSkills: string[];
  flags: string[];
  /** Only contacts published in public data (e.g. an email in the posting). Never guessed. */
  contacts: ContactCandidate[];
}

export interface SourceReport {
  source: string;
  fetched: number;
  kept: number;
  error?: string;
}

export interface SearchResult {
  ranAt: string;
  jobs: FoundJob[];
  sources: SourceReport[];
  warnings: string[];
}

const PROVIDERS: JobProvider[] = [new GreenhouseProvider(), new LeverProvider(), new AshbyProvider(), new WorkdayProvider()];
const BOARDS = ['GREENHOUSE', 'LEVER', 'ASHBY'];

export const PROFILE_PATH = process.env.CANDIDATE_PROFILE_PATH ?? path.resolve(__dirname, '../../../candidate/candidate-profile.md');

export function loadProfile(file = PROFILE_PATH): CandidateProfile {
  return parseProfileMarkdown(fs.readFileSync(file, 'utf8'));
}

/**
 * Hard filters come from the profile: an engineering role, the right level, a location open to India.
 * Words from the candidate's own skills or target roles are never used to exclude a job.
 */
export function criteriaFor(profile: CandidateProfile, maxAgeDays = 30): JobSearchCriteria {
  const own = profile.strongSkills.map((x) => x.toLowerCase());
  const fromRoles = profile.target_roles.map((r) => r.toLowerCase());
  const keep = (k: string) => !own.includes(k.trim()) && !fromRoles.some((r) => ` ${r} `.includes(` ${k.trim()} `));
  return {
    titleKeywords: [],
    requireEngineering: true,
    excludeTitleKeywords: DEFAULT_EXCLUDE_TITLES.filter(keep),
    flagTitleKeywords: Object.fromEntries(Object.entries(FLAG_TITLES).map(([flag, kws]) => [flag, kws.filter(keep)])),
    locations: profile.target_locations.filter((l) => l.toLowerCase() !== 'remote'),
    includeRemote: profile.target_locations.some((l) => l.toLowerCase() === 'remote'),
    allowRelocation: profile.open_to_relocation,
    postedWithinDays: maxAgeDays,
    staleAfterDays: maxAgeDays,
    limit: 2000,
  };
}

/** Turn one raw posting into a scored job, or null when it is unusable (no real description). */
export function toFoundJob(pj: ProviderJob, criteria: JobSearchCriteria, profile: CandidateProfile, now = new Date()): FoundJob | null {
  if (normalizeText(pj.description).length < 50) return null;
  const eligibility = assessEligibility(pj, criteria, now);
  const teamSize = pj.companyMeta?.teamSize ?? null;
  const extraction = extractJob({ title: pj.title, description: pj.description, location: pj.location, companyName: pj.companyName });
  const match = scoreJob({ title: pj.title, location: pj.location, companyName: pj.companyName, companySize: sizeFromTeam(teamSize), extraction }, profile);
  const id = jobSourceHash({ provider: pj.provider, externalId: pj.externalId, url: pj.url }) ?? jobContentHash({ companyName: pj.companyName, title: pj.title, description: pj.description });
  return {
    id,
    title: pj.title.trim(),
    company: pj.companyName,
    companyDomain: pj.companyDomain ?? null,
    location: pj.location ?? null,
    remote: pj.remote ?? null,
    url: pj.url ?? null,
    postedAt: pj.postedAt ? pj.postedAt.toISOString() : null,
    source: pj.provider,
    salaryText: pj.salaryText ?? null,
    teamSize,
    score: match.total,
    recommendation: match.recommendation,
    reasons: match.reasons,
    missingSkills: match.missing,
    flags: [...eligibility.flags, ...(pj.flags ?? [])],
    contacts: pj.contacts ?? [],
  };
}

async function runSource(source: DefaultSource, base: JobSearchCriteria, profile: CandidateProfile): Promise<{ jobs: FoundJob[]; report: SourceReport }> {
  const provider = PROVIDERS.find((p) => p.kind === source.provider);
  if (!provider) return { jobs: [], report: { source: source.name, fetched: 0, kept: 0, error: 'no provider' } };
  const isBoard = BOARDS.includes(source.provider);
  // The age window applies to company boards too: an open role first published months ago is not "latest".
  // Postings with no date at all are kept (flagged `age:unknown`).
  const criteria = base;
  const stats: SearchStats = { fetched: 0, rejected: {}, warnings: [] };
  try {
    const raw = await provider.searchJobs({ ...criteria, stats }, source.config);
    const jobs: FoundJob[] = [];
    for (const pj of raw) {
      const named = {
        ...pj,
        companyName: isBoard && source.config.companyName ? source.config.companyName : pj.companyName,
        companyDomain: pj.companyDomain ?? source.config.domain ?? null,
        companyMeta: pj.companyMeta ?? (source.config.teamSize ? { teamSize: source.config.teamSize } : undefined),
      };
      if (!passesBasicFilters(named, criteria)) continue;
      const job = toFoundJob(named, criteria, profile);
      if (job) jobs.push(job);
    }
    return { jobs, report: { source: source.name, fetched: Math.max(stats.fetched, raw.length), kept: jobs.length } };
  } catch (e) {
    return { jobs: [], report: { source: source.name, fetched: 0, kept: 0, error: (e as Error).message.slice(0, 200) } };
  }
}

/** Filter and score postings from any source the same way. */
export function scoreRaw(raw: ProviderJob[], criteria: JobSearchCriteria, profile: CandidateProfile): FoundJob[] {
  return raw.filter((pj) => passesBasicFilters(pj, criteria)).flatMap((pj) => toFoundJob(pj, criteria, profile) ?? []);
}

/** One site at a time, in one browser, headless. */
async function readSites(opts: NonNullable<Parameters<typeof searchJobs>[0]>['sites'] & object, criteria: JobSearchCriteria, profile: CandidateProfile, days: number) {
  const { openBrowser, readSite } = await import('./browser/runner');
  const { sitesByKey } = await import('./browser/sites');
  const jobs: FoundJob[] = [];
  const reports: SourceReport[] = [];
  const sites = sitesByKey(opts.keys);
  // One browser for all sites. Visible only if a chosen site needs it (its bot check blocks headless Chrome).
  const ctx = await openBrowser(!sites.some((s) => s.headed));
  try {
    for (const site of sites) {
      const r = await readSite(ctx, site, { days, maxJobs: opts.maxJobs, snapshot: opts.snapshot });
      const kept = scoreRaw(r.jobs, criteria, profile);
      jobs.push(...kept);
      reports.push({ source: `${r.site} (browser, ${r.pages} pages)`, fetched: r.jobs.length, kept: kept.length, error: r.error });
    }
  } finally {
    await ctx.close();
  }
  return { jobs, reports };
}

/** Remove the same job seen from two sources (same id, or same company + title). Keeps the higher score. */
export function dedupeJobs(jobs: FoundJob[]): FoundJob[] {
  const byKey = new Map<string, FoundJob>();
  for (const j of jobs) {
    const key = `${j.company.toLowerCase()}|${j.title.toLowerCase()}|${(j.location ?? '').toLowerCase()}`;
    const prev = byKey.get(key);
    if (!prev || j.score > prev.score) byKey.set(key, j);
  }
  const seen = new Set<string>();
  return [...byKey.values()].filter((j) => (seen.has(j.id) ? false : (seen.add(j.id), true)));
}

/**
 * Fetch every source, filter, score and rank. Runs inside the caller's request: no queue, no worker, no database.
 * Sources run a few at a time so one slow board does not hold up the rest.
 */
export async function searchJobs(
  opts: {
    profile?: CandidateProfile;
    maxAgeDays?: number;
    sources?: DefaultSource[];
    concurrency?: number;
    startups?: { minTeam: number; maxTeam: number } | false;
    /** Job boards read through your logged-in Chrome (see src/browser). Off unless asked: it is slow on purpose. */
    sites?: { keys: string[]; snapshot?: boolean; maxJobs?: number };
  } = {},
): Promise<SearchResult> {
  const profile = opts.profile ?? loadProfile();
  const criteria = criteriaFor(profile, opts.maxAgeDays);
  const warnings: string[] = [];
  let extra: DefaultSource[] = [];
  if (!opts.sources && opts.startups !== false) {
    try {
      const r = await startupSources(opts.startups || {});
      extra = r.sources;
      warnings.push(...r.warnings);
    } catch (e) {
      warnings.push(`Startup directory unavailable: ${(e as Error).message.slice(0, 160)}`);
    }
    try {
      const r = await indiaCompanySources();
      extra.push(...r.sources);
      warnings.push(...r.warnings);
    } catch (e) {
      warnings.push(`Indian company boards unavailable: ${(e as Error).message.slice(0, 160)}`);
    }
  }
  // A company in more than one list (curated, startups, India list) is fetched once.
  const curated = opts.sources ?? DEFAULT_SOURCES;
  const boardKey = (s: DefaultSource) => (s.config.boardToken ? `${s.provider}:${s.config.boardToken.toLowerCase()}` : `${s.provider}:${s.name}`);
  const seen = new Set<string>();
  const queue = [...curated, ...extra].filter((s) => (seen.has(boardKey(s)) ? false : (seen.add(boardKey(s)), true)));
  const jobs: FoundJob[] = [];
  const sources: SourceReport[] = [];
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      const r = await runSource(s, criteria, profile);
      jobs.push(...r.jobs);
      sources.push(r.report);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 8 }, worker));
  if (opts.sites?.keys.length) {
    const r = await readSites(opts.sites, criteria, profile, opts.maxAgeDays ?? 30);
    jobs.push(...r.jobs);
    sources.push(...r.reports);
  }
  const ranked = dedupeJobs(jobs).sort((a, b) => b.score - a.score || (b.postedAt ?? '').localeCompare(a.postedAt ?? ''));
  return { ranAt: new Date().toISOString(), jobs: ranked, sources, warnings };
}
