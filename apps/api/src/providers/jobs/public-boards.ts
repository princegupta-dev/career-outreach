import type { JobProviderKind } from '@prisma/client';
import * as cheerio from 'cheerio';
import { categorizeRole } from '../../domain/contacts/rank';
import type { ContactCandidate } from '../contacts/contact-provider';
import { fetchJson, FetchError, httpFetch, isAllowedByRobots } from '../http';
import { extractPostingFromHtml, htmlToText } from './html-extract';
import { filterListed, JobProvider, JobProviderError, JobSearchCriteria, passesBasicFilters, ProviderJob } from './job-provider.interface';
import { searchPlan } from './discovery-queries';

/**
 * More job sources, all through public, documented interfaces:
 *  - Workable / Recruitee: the public job-board APIs those ATSs expose for career sites
 *  - YC "Work at a Startup" listings: public job pages on ycombinator.com (robots.txt allows /jobs)
 *  - Company career pages: schema.org JobPosting JSON-LD published for search engines
 *  - Web search: Google Programmable Search JSON API (official, API key), results resolved
 *    through the ATS providers so every job is read from its original posting
 * Nothing here logs in, solves CAPTCHAs or works around rate limits / bot protection.
 */

const str = (v: unknown): string => (v == null ? '' : String(v)).trim();
const toDate = (v: unknown): Date | null => {
  if (!v) return null;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
};

function token(config: Record<string, unknown>): string {
  const t = str(config.boardToken ?? config.company);
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(t)) throw new JobProviderError('A valid board token is required (e.g. "acme")');
  return t;
}

const EXPERIENCE = /(\d{1,2}\s*(?:\+|-|–|to)\s*\d{0,2}\s*\+?\s*years?)/i;
export function experienceFromText(text: string): string | null {
  return EXPERIENCE.exec(text)?.[1]?.replace(/\s+/g, ' ').trim() ?? null;
}

// ─── Workable ────────────────────────────────────────────────────────────────

interface WorkableJob {
  title: string;
  shortcode: string;
  url?: string;
  shortlink?: string;
  application_url?: string;
  published_on?: string;
  created_at?: string;
  telecommuting?: boolean;
  employment_type?: string;
  experience?: string;
  city?: string;
  state?: string;
  country?: string;
  locations?: Array<{ city?: string; region?: string; country?: string; hidden?: boolean }>;
  description?: string;
}

export function parseWorkable(json: { name?: string; jobs?: WorkableJob[] }, boardToken: string, companyName?: string): ProviderJob[] {
  return (json.jobs ?? []).map((j) => {
    const locs = (j.locations?.length ? j.locations.filter((l) => !l.hidden) : [{ city: j.city, region: j.state, country: j.country }])
      .map((l) => [l.city, l.region, l.country].filter(Boolean).join(', '))
      .filter(Boolean);
    const location = [j.telecommuting ? 'Remote' : '', ...locs].filter(Boolean).join(' / ') || null;
    const description = htmlToText(j.description ?? '');
    const url = j.url ?? j.shortlink ?? `https://apply.workable.com/${boardToken}/j/${j.shortcode}/`;
    return {
      provider: 'WORKABLE' as const,
      externalId: `${boardToken}:${j.shortcode}`,
      url,
      applicationUrl: j.application_url ?? url,
      title: j.title,
      companyName: companyName || json.name || boardToken,
      location,
      remote: j.telecommuting ?? null,
      employmentType: j.employment_type ?? null,
      description,
      postedAt: toDate(j.published_on ?? j.created_at),
      experienceText: experienceFromText(description) ?? (j.experience || null),
    };
  });
}

export class WorkableProvider implements JobProvider {
  readonly kind: JobProviderKind = 'WORKABLE';
  private static URL_RE = /^https?:\/\/apply\.workable\.com\/([^/]+)\/j\/([A-Za-z0-9]+)/i;

  supportsUrl(url: string): boolean {
    return WorkableProvider.URL_RE.test(url);
  }

  private async list(boardToken: string): Promise<{ name?: string; jobs?: WorkableJob[] }> {
    return fetchJson(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(boardToken)}?details=true`);
  }

  async searchJobs(c: JobSearchCriteria, config: Record<string, unknown>): Promise<ProviderJob[]> {
    const t = token(config);
    return filterListed(parseWorkable(await this.list(t), t, str(config.companyName)), c);
  }

  async getJob(url: string): Promise<ProviderJob | null> {
    const m = WorkableProvider.URL_RE.exec(url);
    if (!m) return null;
    return parseWorkable(await this.list(m[1]), m[1]).find((j) => j.externalId === `${m[1]}:${m[2]}`) ?? null;
  }
}

// ─── Recruitee ───────────────────────────────────────────────────────────────

interface RecruiteeOffer {
  id: number;
  slug?: string;
  title: string;
  description?: string;
  requirements?: string;
  location?: string;
  city?: string;
  country?: string;
  remote?: boolean;
  careers_url?: string;
  careers_apply_url?: string;
  published_at?: string;
  created_at?: string;
  company_name?: string;
  employment_type_code?: string;
}

export function parseRecruitee(json: { offers?: RecruiteeOffer[] }, boardToken: string, companyName?: string): ProviderJob[] {
  return (json.offers ?? []).map((o) => {
    const description = htmlToText(`${o.description ?? ''}\n${o.requirements ?? ''}`);
    const location = [o.remote ? 'Remote' : '', o.location || [o.city, o.country].filter(Boolean).join(', ')].filter(Boolean).join(' / ') || null;
    const url = o.careers_url ?? `https://${boardToken}.recruitee.com/o/${o.slug ?? o.id}`;
    return {
      provider: 'RECRUITEE' as const,
      externalId: `${boardToken}:${o.id}`,
      url,
      applicationUrl: o.careers_apply_url ?? url,
      title: o.title,
      companyName: companyName || o.company_name || boardToken,
      location,
      remote: o.remote ?? null,
      employmentType: o.employment_type_code ?? null,
      description,
      postedAt: toDate(o.published_at ?? o.created_at),
      experienceText: experienceFromText(description),
    };
  });
}

export class RecruiteeProvider implements JobProvider {
  readonly kind: JobProviderKind = 'RECRUITEE';
  private static URL_RE = /^https?:\/\/([a-z0-9-]+)\.recruitee\.com\/o\/([^/?#]+)/i;

  supportsUrl(url: string): boolean {
    return RecruiteeProvider.URL_RE.test(url);
  }

  async searchJobs(c: JobSearchCriteria, config: Record<string, unknown>): Promise<ProviderJob[]> {
    const t = token(config);
    const json = await fetchJson<{ offers?: RecruiteeOffer[] }>(`https://${t}.recruitee.com/api/offers/`);
    return filterListed(parseRecruitee(json, t, str(config.companyName)), c);
  }

  async getJob(url: string): Promise<ProviderJob | null> {
    const m = RecruiteeProvider.URL_RE.exec(url);
    if (!m) return null;
    const json = await fetchJson<{ offers?: RecruiteeOffer[] }>(`https://${m[1]}.recruitee.com/api/offers/`);
    return parseRecruitee(json, m[1]).find((j) => j.url?.includes(`/o/${m[2]}`)) ?? null;
  }
}

// ─── YC jobs (ycombinator.com/jobs) ──────────────────────────────────────────

interface YcPosting {
  id: number;
  title: string;
  url: string;
  location?: string;
  type?: string;
  salaryRange?: string;
  minExperience?: string;
  companyName?: string;
  companyUrl?: string;
  createdAt?: string;
  description?: string;
  hiringManager?: { name?: string; title?: string } | string | null;
}

interface YcCompany {
  name?: string;
  website?: string;
  founders?: Array<{ full_name?: string; title?: string; linkedin_url?: string }>;
}

function inertiaProps(html: string): Record<string, unknown> | null {
  const m = /data-page="([^"]+)"/.exec(html);
  if (!m) return null;
  try {
    const decoded = cheerio.load(`<i>${m[1]}</i>`)('i').text();
    return (JSON.parse(decoded) as { props?: Record<string, unknown> }).props ?? null;
  } catch {
    return null;
  }
}

/** YC shows ages like "3 days" / "about 1 month"; convert to an approximate date. */
export function ycAgeToDate(age: string | undefined, now = new Date()): Date | null {
  const m = /(\d+|an?|about an?)\s*(minute|hour|day|week|month|year)s?/i.exec(age ?? '');
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : 1;
  const unit: Record<string, number> = { minute: 60e3, hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3, year: 365 * 86400e3 };
  return new Date(now.getTime() - n * unit[m[2].toLowerCase()]);
}

export function parseYcListing(html: string, now = new Date()): ProviderJob[] {
  const props = inertiaProps(html);
  const postings = (props?.jobPostings as YcPosting[] | undefined) ?? [];
  return postings.map((p) => {
    const url = new URL(p.url, 'https://www.ycombinator.com').toString();
    return {
      provider: 'YC_JOBS' as const,
      externalId: String(p.id),
      url,
      // Applying goes through a YC account, so the listing itself is where to apply.
      applicationUrl: url,
      title: p.title,
      companyName: p.companyName ?? 'Unknown',
      location: p.location ?? null,
      remote: p.location ? /remote/i.test(p.location) : null,
      employmentType: p.type ?? null,
      description: '',
      postedAt: ycAgeToDate(p.createdAt, now),
      salaryText: p.salaryRange ?? null,
      experienceText: p.minExperience ?? null,
    };
  });
}

/** Detail page: full description, company website, founders (names only — YC publishes no emails). */
export function parseYcDetail(html: string, url: string): Partial<ProviderJob> | null {
  const props = inertiaProps(html);
  const job = props?.job as YcPosting | undefined;
  const company = props?.company as YcCompany | undefined;
  if (!job) return null;
  const contacts: ContactCandidate[] = (company?.founders ?? [])
    .filter((f) => f.full_name)
    .map((f) => ({
      name: f.full_name!,
      role: f.title || 'Founder',
      roleCategory: categorizeRole(f.title || 'Founder'),
      email: null,
      linkedinUrl: f.linkedin_url ?? null,
      source: 'yc_jobs',
      sourceUrl: url,
      confidence: 'VERIFIED' as const,
      sourceType: 'YC_PAGE' as const,
      verificationStatus: 'UNKNOWN' as const,
    }));
  let domain: string | null = null;
  try {
    domain = company?.website ? new URL(company.website).hostname.replace(/^www\./, '') : null;
  } catch {
    domain = null;
  }
  return {
    description: htmlToText(job.description ?? ''),
    companyWebsite: company?.website ?? null,
    companyDomain: domain,
    contacts,
  };
}

export class YcJobsProvider implements JobProvider {
  readonly kind: JobProviderKind = 'YC_JOBS';
  static readonly DEFAULT_PATHS = ['/jobs/role/software-engineer/backend', '/jobs/role/software-engineer/full-stack', '/jobs/role/software-engineer/remote'];

  supportsUrl(url: string): boolean {
    return /^https?:\/\/(www\.)?ycombinator\.com\/companies\/[^/]+\/jobs\/[^/?#]+/i.test(url);
  }

  private async page(url: string): Promise<string | null> {
    if (!(await isAllowedByRobots(url))) return null;
    const r = await httpFetch(url, { timeoutMs: 15_000 });
    if (r.status === 404) return null;
    if (r.status >= 400) throw new FetchError(`HTTP ${r.status} from ycombinator.com`, r.status);
    return r.text;
  }

  async searchJobs(c: JobSearchCriteria, config: Record<string, unknown>): Promise<ProviderJob[]> {
    const paths = Array.isArray(config.paths) && config.paths.length ? (config.paths as string[]) : YcJobsProvider.DEFAULT_PATHS;
    const seen = new Map<string, ProviderJob>();
    for (const p of paths) {
      if (!/^\/jobs\//.test(p)) continue;
      const html = await this.page(`https://www.ycombinator.com${p}`);
      for (const j of html ? parseYcListing(html) : []) seen.set(j.externalId!, j);
    }
    if (c.stats) c.stats.fetched += seen.size;
    // Listing has no description: fetch details only for postings that pass the cheap filters.
    const candidates = [...seen.values()].filter((j) => passesBasicFilters(j, c)).slice(0, Number(config.maxDetails ?? 25));
    const out: ProviderJob[] = [];
    for (const j of candidates) {
      const html = await this.page(j.url!).catch(() => null);
      const detail = html ? parseYcDetail(html, j.url!) : null;
      if (detail?.description) out.push({ ...j, ...detail } as ProviderJob);
    }
    return out;
  }

  async getJob(url: string): Promise<ProviderJob | null> {
    const html = await this.page(url);
    if (!html) return null;
    const props = inertiaProps(html);
    const job = props?.job as YcPosting | undefined;
    const detail = parseYcDetail(html, url);
    if (!job || !detail?.description) return null;
    return {
      provider: 'YC_JOBS',
      externalId: String(job.id),
      url,
      applicationUrl: url,
      title: job.title,
      companyName: job.companyName ?? (props?.company as YcCompany | undefined)?.name ?? 'Unknown',
      location: job.location ?? null,
      remote: job.location ? /remote/i.test(job.location) : null,
      postedAt: ycAgeToDate(job.createdAt),
      salaryText: job.salaryRange ?? null,
      experienceText: job.minExperience ?? null,
      ...detail,
    } as ProviderJob;
  }
}

// ─── Company career pages (schema.org JobPosting) ────────────────────────────

const JOB_LINK = /\/(jobs?|careers?|positions?|openings?|vacanc(y|ies)|roles?)\//i;

/** Same-site links that look like individual postings. */
export function postingLinks(html: string, baseUrl: string, max = 25): string[] {
  const base = new URL(baseUrl);
  const $ = cheerio.load(html);
  const out = new Set<string>();
  $('a[href]').each((_, el) => {
    try {
      const u = new URL($(el).attr('href')!, base);
      u.hash = '';
      if (u.hostname === base.hostname && JOB_LINK.test(u.pathname) && u.pathname !== base.pathname && u.pathname.split('/').filter(Boolean).length >= 2) out.add(u.toString());
    } catch {
      /* ignore bad hrefs */
    }
  });
  return [...out].slice(0, max);
}

export class CareerPageProvider implements JobProvider {
  readonly kind: JobProviderKind = 'CAREER_PAGE';

  supportsUrl(): boolean {
    return false; // single URLs go through the generic URL importer
  }

  private async get(url: string): Promise<string | null> {
    if (!(await isAllowedByRobots(url))) return null;
    const r = await httpFetch(url, { timeoutMs: 15_000 });
    return r.status < 400 && /html/i.test(r.contentType) ? r.text : null;
  }

  async searchJobs(c: JobSearchCriteria, config: Record<string, unknown>): Promise<ProviderJob[]> {
    const pageUrl = str(config.url);
    if (!/^https:\/\//i.test(pageUrl)) throw new JobProviderError('A careers page URL (https://…) is required');
    const companyName = str(config.companyName);
    const html = await this.get(pageUrl);
    if (!html) throw new JobProviderError(`${new URL(pageUrl).hostname} could not be read (robots.txt or HTTP error)`);
    const out: ProviderJob[] = [];
    const add = (url: string, page: string) => {
      const p = extractPostingFromHtml(page);
      // Only structured postings: a careers index page's text is not a job description.
      if (!p?.title || !p.postedAt) return;
      out.push({
        provider: 'CAREER_PAGE',
        externalId: null,
        url,
        sourceUrl: pageUrl,
        title: p.title,
        companyName: companyName || p.companyName || new URL(pageUrl).hostname,
        companyWebsite: p.companyWebsite ?? null,
        location: p.location ?? null,
        remote: p.remote ?? null,
        employmentType: p.employmentType ?? null,
        description: p.description,
        postedAt: p.postedAt,
        salaryText: p.salaryText ?? null,
        experienceText: experienceFromText(p.description),
      });
    };
    add(pageUrl, html);
    if (!out.length) {
      for (const link of postingLinks(html, pageUrl, Number(config.maxPages ?? 25))) {
        const page = await this.get(link).catch(() => null);
        if (page) add(link, page);
      }
    }
    return filterListed(out, c);
  }

  async getJob(): Promise<ProviderJob | null> {
    return null;
  }
}

// ─── Web search (Google Programmable Search JSON API) ────────────────────────

const ATS_SITES = ['boards.greenhouse.io', 'job-boards.greenhouse.io', 'jobs.lever.co', 'jobs.ashbyhq.com', 'apply.workable.com'];

/**
 * Searches the web for fresh postings on public ATS boards and reads each hit from its
 * original posting via the matching provider. Requires GOOGLE_CSE_API_KEY + GOOGLE_CSE_ID
 * (free tier: 100 queries/day — `maxQueries` per run keeps well inside it).
 */
export class WebSearchProvider implements JobProvider {
  readonly kind: JobProviderKind = 'WEB_SEARCH';

  constructor(
    private readonly resolvers: JobProvider[],
    private readonly apiKey?: string,
    private readonly engineId?: string,
  ) {}

  get enabled(): boolean {
    return !!this.apiKey && !!this.engineId;
  }

  supportsUrl(): boolean {
    return false;
  }

  async getJob(): Promise<ProviderJob | null> {
    return null;
  }

  async searchJobs(c: JobSearchCriteria, config: Record<string, unknown>): Promise<ProviderJob[]> {
    if (!this.enabled) throw new JobProviderError('Web search is not configured (set GOOGLE_CSE_API_KEY and GOOGLE_CSE_ID).');
    const days = Math.min(7, Math.max(1, Number(config.withinDays ?? 3)));
    const sites = ATS_SITES.map((s) => `site:${s}`).join(' OR ');
    const urls = new Set<string>();
    for (const q of searchPlan(Math.min(40, Number(config.maxQueries ?? 10)))) {
      const params = new URLSearchParams({ key: this.apiKey!, cx: this.engineId!, q: `${q} (${sites})`, dateRestrict: `d${days}`, num: '10' });
      const res = await fetchJson<{ items?: Array<{ link?: string }> }>(`https://www.googleapis.com/customsearch/v1?${params}`);
      for (const it of res.items ?? []) if (it.link) urls.add(it.link.split('#')[0]);
    }
    if (c.stats) c.stats.fetched += urls.size;
    const out: ProviderJob[] = [];
    for (const url of urls) {
      const resolver = this.resolvers.find((r) => r.supportsUrl(url));
      if (!resolver) continue;
      const job = await resolver.getJob(url).catch(() => null);
      if (job) out.push({ ...job, sourceUrl: url });
    }
    return filterListed(out, c);
  }
}
