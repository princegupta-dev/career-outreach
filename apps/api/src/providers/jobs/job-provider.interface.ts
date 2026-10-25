import type { JobProviderKind } from '@prisma/client';
import type { ContactCandidate } from '../contacts/contact-provider';

/** Normalised job as returned by any provider (before persistence). */
export interface ProviderJob {
  provider: JobProviderKind;
  externalId?: string | null;
  url?: string | null;
  title: string;
  companyName: string;
  companyDomain?: string | null;
  companyWebsite?: string | null;
  location?: string | null;
  remote?: boolean | null;
  employmentType?: string | null;
  description: string;
  postedAt?: Date | null;
  salaryText?: string | null;
  /** Contacts published in the posting itself (e.g. HN "email me at …"). */
  contacts?: ContactCandidate[];
  /** Verifiable facts about the company, when the source (e.g. a startup directory) reports them. */
  companyMeta?: CompanyMeta;
}

export interface CompanyMeta {
  teamSize?: number | null;
  category?: string | null;
  careerUrl?: string | null;
  /** Where these facts came from, e.g. { source: 'yc-oss', url, fetchedAt }. */
  provenance?: Record<string, unknown> | null;
}

export interface JobSearchCriteria {
  /** Title must contain one of these (case-insensitive). Empty = no filter. */
  titleKeywords: string[];
  /** Title must not contain any of these (hard rules: wrong function or level, e.g. sales, manager, intern). */
  excludeTitleKeywords: string[];
  /** Title must look like an engineering role (see ENGINEERING_TITLE). Use instead of a narrow keyword list. */
  requireEngineering?: boolean;
  /** Soft signals: flag name → title keywords. A match adds `flag:keyword` to the job's eligibility flags; it never rejects. */
  flagTitleKeywords?: Record<string, string[]>;
  /** Postings older than this get an `age:older-than-Nd` flag (used for sources that are not age-filtered, such as company boards). */
  staleAfterDays?: number;
  /** Location must contain one of these, or the job must be remote. Empty = no filter. */
  locations: string[];
  includeRemote: boolean;
  postedWithinDays?: number;
  limit?: number;
  allowRelocation?: boolean;
  /** Providers add the number of postings they listed (before filtering) for the funnel, why others were dropped, and anything that went wrong part-way. */
  stats?: SearchStats;
}

export interface SearchStats {
  fetched: number;
  /** Basic-filter rejections by reason code (see `basicFilterReason`). */
  rejected?: Record<string, number>;
  /** Partial failures that did not fail the whole source (e.g. one feed of three returned HTTP 500). */
  warnings?: string[];
}

/** Record a partial failure so it shows up in the run stats instead of vanishing. */
export function warn(c: JobSearchCriteria, message: string): void {
  if (c.stats) (c.stats.warnings ??= []).push(message);
}

/** Tolerant date parsing for upstream payloads: epoch seconds/millis, ISO, "YYYY-MM-DD HH:MM:SS", RFC-822. Garbage → null (never an Invalid Date). */
export function parseDate(v: unknown): Date | null {
  if (v == null || v === '') return null;
  let d: Date;
  if (typeof v === 'number' || (typeof v === 'string' && /^\d{9,13}$/.test(v.trim()))) {
    const n = Number(v);
    d = new Date(n < 1e12 ? n * 1000 : n);
  } else {
    const str = String(v).trim();
    d = new Date(/^\d{4}-\d{2}-\d{2} \d/.test(str) ? str.replace(' ', 'T') : str);
  }
  return isNaN(d.getTime()) ? null : d;
}

export interface JobProvider {
  readonly kind: JobProviderKind;
  /** Can this provider resolve the given URL? */
  supportsUrl(url: string): boolean;
  /** Returns postings that pass the basic filters (providers may use them to avoid fetching details). */
  searchJobs(criteria: JobSearchCriteria, config: Record<string, unknown>): Promise<ProviderJob[]>;
  getJob(url: string): Promise<ProviderJob | null>;
}

export class JobProviderError extends Error {}

const INDIA = /\b(india|bangalore|bengaluru|gurgaon|gurugram|noida|delhi|ncr|pune|hyderabad|mumbai|chennai|kolkata|ahmedabad|jaipur|indore|chandigarh|kochi|trivandrum|coimbatore)\b/i;
const GLOBAL = /\b(worldwide|anywhere|global|globally|international|apac|asia|asia[- ]pacific|all locations|any location|any timezone|any time zone)\b/i;
/** Timezones that work from India. */
const INDIA_TZ = /\b(ist|(?:utc|gmt)\s*\+\s*5(?::?30)?)(?![0-9:])/i;
const NOT_STATED = /^(n\/?a|tbd|tba|unknown|not (?:specified|stated)|unspecified|none|-+|\?)$/i;
/** Words that say "remote" without saying where. */
const REMOTE_WORDS = /\b(fully|100%|remote|work from home|wfh|distributed|only|first|friendly|role|position|job|flexible|hybrid|onsite|on-site|home based|home-based)\b/g;

/**
 * Where can this job be done from, for someone in India?
 *  - india:        an Indian city/country is named
 *  - global:       worldwide / anywhere / APAC / Asia / India's timezone
 *  - unspecified:  nothing stated, or just "Remote" — kept, but flagged as uncertain
 *  - restricted:   some other place is named (a country, region, city, state, timezone) — not open to India
 * A whitelist on purpose: an unknown place name ("Denver", "Krakow") must not pass just because we have not listed it.
 */
export type LocationClass = 'india' | 'global' | 'unspecified' | 'restricted';

export function classifyLocation(location: string | null | undefined): LocationClass {
  const loc = (location ?? '').trim();
  if (!loc || NOT_STATED.test(loc)) return 'unspecified';
  if (INDIA.test(loc)) return 'india';
  if (GLOBAL.test(loc) || INDIA_TZ.test(loc)) return 'global';
  if (loc.toLowerCase().replace(REMOTE_WORDS, '').replace(/[\s,.\-–—/()|·:;]+/g, '') === '') return 'unspecified';
  return 'restricted';
}

/** When the location is just "Remote", the region is often in the title: "Software Engineer - Latam", "Support (EMEA)". */
const TITLE_REGION_LOCKED = /\b(latam|latin america|emea|amer|americas|north america|europe)\b|\((?:us|usa|u\.s\.|uk|eu|canada)\)|[-–—,]\s*(?:us|usa|u\.s\.|uk|canada|europe|eu|germany|france|spain|australia|brazil|mexico)\s*$/i;
const TITLE_REGION_OPEN = /\b(apac|asia[- ]pacific|worldwide)\b/i;

/** `classifyLocation`, plus the region named in the title when the location itself says nothing. */
export function classifyPosting(location: string | null | undefined, title: string): LocationClass {
  const where = classifyLocation(location);
  if (where !== 'unspecified') return where;
  if (INDIA.test(title)) return 'india';
  if (TITLE_REGION_OPEN.test(title)) return 'global';
  return TITLE_REGION_LOCKED.test(title) ? 'restricted' : 'unspecified';
}

/** Anything that reads like an engineering role. Deliberately broad: fit is the ranker's job. */
export const ENGINEERING_TITLE = /engineer|developer|\bsde\b|\bswe\b|software development|architect|\bsre\b|devops|programmer|member of technical staff|\bmts\b|tech(?:nical)? lead|full[- ]?stack|back[- ]?end/i;

const kwCache = new Map<string, RegExp>();
/** Keyword match on token boundaries ("rust" must not match "trust", ".net"/"c++" work). */
export function titleHas(title: string, keyword: string): boolean {
  const k = keyword.trim().toLowerCase();
  if (!k) return false;
  let re = kwCache.get(k);
  if (!re) {
    // "staff+" must still match "staff"; only keywords like "c++" / "c#" care about a trailing + or #.
    const tail = /[+#]$/.test(k) || k.length <= 2 ? '[^a-z0-9+#]' : '[^a-z0-9#]';
    re = new RegExp(`(^|[^a-z0-9+#.])${k.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}($|${tail})`, 'i');
    kwCache.set(k, re);
  }
  return re.test(title);
}

/** For a remote job: is the allowed region compatible with someone based in India? (A bare "Remote" is, tentatively.) */
export function remoteRegionOk(location: string | null | undefined): boolean {
  return classifyLocation(location) !== 'restricted';
}

export function isIndiaLocation(location: string | null | undefined): boolean {
  return INDIA.test(location ?? '');
}

/** "Member of Technical Staff" is an ordinary engineering title, not the staff level the "staff" exclusion is for. */
const MTS = /\bmember of (?:the )?technical staff\b/gi;

/**
 * Cheap pre-filter applied before any scoring (step 1 of the token-saving pipeline):
 * title keywords, region compatibility, posting age.
 * Returns why the posting is rejected, or null when it passes.
 */
export function basicFilterReason(
  job: Pick<ProviderJob, 'title' | 'location' | 'remote' | 'postedAt'>,
  c: JobSearchCriteria,
  now = new Date(),
): string | null {
  const title = job.title.toLowerCase();
  if (c.titleKeywords.length && !c.titleKeywords.some((k) => titleHas(title, k))) return 'title:no-keyword';
  if (c.requireEngineering && !ENGINEERING_TITLE.test(title)) return 'title:not-engineering';
  const excludable = title.replace(MTS, ' ');
  if (c.excludeTitleKeywords.some((k) => titleHas(excludable, k))) return 'title:excluded';
  if (c.locations.length || c.includeRemote) {
    const loc = (job.location ?? '').toLowerCase();
    const remote = job.remote === true || /\bremote\b|anywhere|worldwide|work from home|distributed/.test(loc);
    const where = c.locations.some((l) => titleHas(loc, l)) ? 'india' : classifyPosting(job.location, job.title);
    if (where === 'restricted') {
      if (remote) return 'region:remote-not-india-compatible';
      if (!c.allowRelocation) return 'region:onsite-outside-targets';
    } else if (remote && !c.includeRemote && where !== 'india') {
      return 'region:remote-not-india-compatible';
    }
  }
  if (c.postedWithinDays && job.postedAt && now.getTime() - job.postedAt.getTime() > c.postedWithinDays * 86_400_000) return 'age:too-old';
  return null;
}

export interface Eligibility {
  /** ELIGIBLE = clearly open to a candidate in India. UNCERTAIN = kept, but the region is not stated. */
  status: 'ELIGIBLE' | 'UNCERTAIN';
  /** Soft signals for the ranker (never reasons to drop a job). */
  flags: string[];
}

/** Call only for postings that passed `basicFilterReason`. Explains what is uncertain or a mismatch instead of discarding. */
export function assessEligibility(job: Pick<ProviderJob, 'title' | 'location' | 'remote' | 'postedAt'>, c: JobSearchCriteria, now = new Date()): Eligibility {
  const flags: string[] = [];
  const title = job.title.toLowerCase().replace(MTS, ' ');
  for (const [flag, keywords] of Object.entries(c.flagTitleKeywords ?? {})) {
    const hit = keywords.find((k) => titleHas(title, k));
    if (hit) flags.push(`${flag}:${hit}`);
  }
  const where = c.locations.some((l) => titleHas((job.location ?? '').toLowerCase(), l)) ? 'india' : classifyPosting(job.location, job.title);
  let status: Eligibility['status'] = 'ELIGIBLE';
  if (where === 'unspecified') {
    status = 'UNCERTAIN';
    flags.push(job.remote === true ? 'location:remote-region-unstated' : 'location:unspecified');
  } else if (where === 'restricted') {
    flags.push('location:requires-relocation');
  }
  if (!job.postedAt) flags.push('age:unknown');
  else if (c.staleAfterDays && now.getTime() - job.postedAt.getTime() > c.staleAfterDays * 86_400_000) flags.push(`age:older-than-${c.staleAfterDays}d`);
  return { status, flags };
}

export function passesBasicFilters(job: Pick<ProviderJob, 'title' | 'location' | 'remote' | 'postedAt'>, c: JobSearchCriteria, now = new Date()): boolean {
  return basicFilterReason(job, c, now) === null;
}

/** Count listed postings, tally why the others were dropped, and keep only those passing the basic filters. */
export function filterListed(all: ProviderJob[], c: JobSearchCriteria): ProviderJob[] {
  if (c.stats) c.stats.fetched += all.length;
  const kept: ProviderJob[] = [];
  for (const j of all) {
    const reason = basicFilterReason(j, c);
    if (reason === null) kept.push(j);
    else if (c.stats) {
      const r = (c.stats.rejected ??= {});
      r[reason] = (r[reason] ?? 0) + 1;
    }
  }
  return kept.slice(0, c.limit ?? 500);
}
