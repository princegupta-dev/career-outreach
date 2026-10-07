import type { JobProviderKind } from '@prisma/client';
import * as cheerio from 'cheerio';
import { categorizeRole } from '../../domain/contacts/rank';
import type { ContactCandidate } from '../contacts/contact-provider';
import { fetchJson, httpFetch, FetchError } from '../http';
import { htmlToText } from './html-extract';
import { filterListed, JobProvider, JobSearchCriteria, ProviderJob } from './job-provider.interface';

/**
 * Public, documented job feeds. They are searched (not scraped), at most a few
 * times a day, and every job links back to its original posting.
 */

const toDate = (v: unknown): Date | null => {
  if (v == null || v === '') return null;
  const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(String(v).replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
};
const str = (v: unknown): string => (v == null ? '' : String(v)).trim();
const salary = (min: unknown, max: unknown, cur: unknown): string | null => (min || max ? `${str(cur) || 'USD'} ${min || max} - ${max || min} per year` : null);

abstract class FeedProvider implements JobProvider {
  abstract readonly kind: JobProviderKind;
  supportsUrl(): boolean {
    return false;
  }
  async getJob(): Promise<ProviderJob | null> {
    return null;
  }
  abstract searchJobs(criteria: JobSearchCriteria, config: Record<string, unknown>): Promise<ProviderJob[]>;
}

// ─── Remotive ────────────────────────────────────────────────────────────────

interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  category?: string;
  job_type?: string;
  publication_date?: string;
  candidate_required_location?: string;
  salary?: string;
  description?: string;
}

export function parseRemotive(json: { jobs?: RemotiveJob[] }): ProviderJob[] {
  return (json.jobs ?? []).map((j) => ({
    provider: 'REMOTIVE',
    externalId: String(j.id),
    url: j.url,
    title: str(j.title),
    companyName: str(j.company_name),
    location: `Remote${j.candidate_required_location ? ` (${j.candidate_required_location})` : ''}`,
    remote: true,
    employmentType: j.job_type ?? null,
    description: htmlToText(j.description ?? ''),
    postedAt: toDate(j.publication_date),
    salaryText: j.salary || null,
  }));
}

export class RemotiveProvider extends FeedProvider {
  readonly kind = 'REMOTIVE' as const;
  async searchJobs(c: JobSearchCriteria): Promise<ProviderJob[]> {
    return filterListed(parseRemotive(await fetchJson('https://remotive.com/api/remote-jobs?category=software-development&limit=300')), c);
  }
}

// ─── Himalayas ───────────────────────────────────────────────────────────────

interface HimalayasJob {
  guid?: string;
  title: string;
  companyName: string;
  companySlug?: string;
  employmentType?: string;
  minSalary?: number;
  maxSalary?: number;
  currency?: string;
  salaryCurrency?: string;
  locationRestrictions?: string[];
  description?: string;
  excerpt?: string;
  pubDate?: number | string;
  applicationLink?: string;
}

export function parseHimalayas(json: { jobs?: HimalayasJob[] }): ProviderJob[] {
  return (json.jobs ?? []).map((j) => ({
    provider: 'HIMALAYAS',
    externalId: j.guid ?? `${j.companySlug}:${j.title}`,
    url: j.applicationLink ?? j.guid ?? null,
    title: str(j.title),
    companyName: str(j.companyName),
    location: `Remote${j.locationRestrictions?.length ? ` (${j.locationRestrictions.join(', ')})` : ' (Worldwide)'}`,
    remote: true,
    employmentType: j.employmentType ?? null,
    description: htmlToText(j.description ?? j.excerpt ?? ''),
    postedAt: toDate(j.pubDate),
    salaryText: salary(j.minSalary, j.maxSalary, j.currency ?? j.salaryCurrency),
  }));
}

export class HimalayasProvider extends FeedProvider {
  readonly kind = 'HIMALAYAS' as const;
  async searchJobs(c: JobSearchCriteria): Promise<ProviderJob[]> {
    const pages = await Promise.all([0, 100].map((offset) => fetchJson<{ jobs?: HimalayasJob[] }>(`https://himalayas.app/jobs/api?limit=100&offset=${offset}`)));
    return filterListed(pages.flatMap(parseHimalayas), c);
  }
}

// ─── Jobicy ──────────────────────────────────────────────────────────────────

interface JobicyJob {
  id: number;
  url: string;
  jobTitle: string;
  companyName: string;
  jobGeo?: string;
  jobType?: string[] | string;
  jobDescription?: string;
  jobExcerpt?: string;
  pubDate?: string;
  annualSalaryMin?: number | string;
  annualSalaryMax?: number | string;
  salaryCurrency?: string;
}

export function parseJobicy(json: { jobs?: JobicyJob[] }): ProviderJob[] {
  return (json.jobs ?? []).map((j) => ({
    provider: 'JOBICY',
    externalId: String(j.id),
    url: j.url,
    title: str(j.jobTitle),
    companyName: str(j.companyName),
    location: `Remote${j.jobGeo ? ` (${j.jobGeo})` : ''}`,
    remote: true,
    employmentType: Array.isArray(j.jobType) ? j.jobType.join(', ') : (j.jobType ?? null),
    description: htmlToText(j.jobDescription ?? j.jobExcerpt ?? ''),
    postedAt: toDate(j.pubDate),
    salaryText: salary(j.annualSalaryMin, j.annualSalaryMax, j.salaryCurrency),
  }));
}

export class JobicyProvider extends FeedProvider {
  readonly kind = 'JOBICY' as const;
  async searchJobs(c: JobSearchCriteria): Promise<ProviderJob[]> {
    const tags = ['backend', 'node', 'typescript'];
    const res = await Promise.allSettled(tags.map((t) => fetchJson<{ jobs?: JobicyJob[] }>(`https://jobicy.com/api/v2/remote-jobs?count=100&tag=${t}`)));
    const ok = res.filter((r): r is PromiseFulfilledResult<{ jobs?: JobicyJob[] }> => r.status === 'fulfilled');
    if (!ok.length) throw (res[0] as PromiseRejectedResult).reason;
    return filterListed(ok.flatMap((r) => parseJobicy(r.value)), c);
  }
}

// ─── Arbeitnow ───────────────────────────────────────────────────────────────

interface ArbeitnowJob {
  slug: string;
  company_name: string;
  title: string;
  description?: string;
  remote?: boolean;
  url: string;
  location?: string;
  created_at?: number;
  job_types?: string[];
}

export function parseArbeitnow(json: { data?: ArbeitnowJob[] }): ProviderJob[] {
  return (json.data ?? []).map((j) => ({
    provider: 'ARBEITNOW',
    externalId: j.slug,
    url: j.url,
    title: str(j.title),
    companyName: str(j.company_name),
    location: j.remote ? `Remote${j.location ? ` (${j.location})` : ''}` : (j.location ?? null),
    remote: j.remote ?? null,
    employmentType: j.job_types?.join(', ') ?? null,
    description: htmlToText(j.description ?? ''),
    postedAt: toDate(j.created_at),
  }));
}

export class ArbeitnowProvider extends FeedProvider {
  readonly kind = 'ARBEITNOW' as const;
  async searchJobs(c: JobSearchCriteria): Promise<ProviderJob[]> {
    const res = await Promise.allSettled([1, 2].map((p) => fetchJson<{ data?: ArbeitnowJob[] }>(`https://www.arbeitnow.com/api/job-board-api?page=${p}`)));
    const ok = res.filter((r): r is PromiseFulfilledResult<{ data?: ArbeitnowJob[] }> => r.status === 'fulfilled');
    if (!ok.length) throw (res[0] as PromiseRejectedResult).reason;
    return filterListed(ok.flatMap((r) => parseArbeitnow(r.value)), c);
  }
}

// ─── Remote OK ───────────────────────────────────────────────────────────────

interface RemoteOkJob {
  id?: string | number;
  slug?: string;
  position?: string;
  company?: string;
  description?: string;
  location?: string;
  date?: string;
  url?: string;
  salary_min?: number;
  salary_max?: number;
  tags?: string[];
}

export function parseRemoteOk(json: RemoteOkJob[]): ProviderJob[] {
  return json
    .filter((j) => j.id && j.position && j.company)
    .map((j) => ({
      provider: 'REMOTEOK' as const,
      externalId: String(j.id),
      url: j.url ?? `https://remoteok.com/remote-jobs/${j.slug ?? j.id}`,
      title: str(j.position),
      companyName: str(j.company),
      location: `Remote${j.location ? ` (${j.location})` : ''}`,
      remote: true,
      description: htmlToText(j.description ?? '') + (j.tags?.length ? `\nTags: ${j.tags.join(', ')}` : ''),
      postedAt: toDate(j.date),
      salaryText: salary(j.salary_min, j.salary_max, 'USD'),
    }));
}

export class RemoteOkProvider extends FeedProvider {
  readonly kind = 'REMOTEOK' as const;
  async searchJobs(c: JobSearchCriteria): Promise<ProviderJob[]> {
    return filterListed(parseRemoteOk(await fetchJson<RemoteOkJob[]>('https://remoteok.com/api?tag=backend')), c);
  }
}

// ─── Hacker News "Who is hiring?" ────────────────────────────────────────────

const ROLE_HINT = /engineer|developer|sde|swe|backend|back-end|full.?stack|programmer|architect|devops|sre|platform|infrastructure/i;
const LOC_HINT = /remote|onsite|on-site|hybrid|in[- ]office|india|bangalore|bengaluru|london|berlin|new york|nyc|sf|san francisco|europe|us|usa|eu|worldwide|anywhere|apac/i;
const EMAIL_PLAIN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const EMAIL_OBFUSCATED = /([A-Za-z0-9._%+-]+)\s*(?:\[at\]|\(at\)|\{at\}|\sat\s)\s*([A-Za-z0-9-]+(?:\s*(?:\[dot\]|\(dot\)|\{dot\}|\sdot\s|\.)\s*[A-Za-z0-9-]+)+)/gi;

export function extractEmails(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(EMAIL_PLAIN)) found.add(m[0].replace(/[.,;)]+$/, '').toLowerCase());
  for (const m of text.matchAll(EMAIL_OBFUSCATED)) {
    const domain = m[2].replace(/\s*(?:\[dot\]|\(dot\)|\{dot\}|\sdot\s)\s*/gi, '.').replace(/\s+/g, '');
    if (/\.[a-z]{2,}$/i.test(domain) && /(\[|\(|\{|\sdot\s)/i.test(m[0])) found.add(`${m[1]}@${domain}`.toLowerCase());
  }
  return [...found].filter((e) => !/@(example|domain|company)\.(com|org)$/.test(e));
}

function decodeHtml(s: string): string {
  return cheerio.load(`<div>${s}</div>`)('div').text();
}

export interface HnComment {
  objectID: string;
  author?: string;
  created_at?: string;
  comment_text?: string;
  parent_id?: number | string;
}

/** Parse one top-level "Who is hiring?" comment: `Company | Role | Location | …`. */
export function parseHnComment(c: HnComment): ProviderJob | null {
  const html = c.comment_text ?? '';
  if (!html) return null;
  const firstHtml = html.split(/<p>/i)[0];
  const first = decodeHtml(firstHtml).replace(/\s+/g, ' ').trim();
  const parts = first.split('|').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const link = /href="([^"]+)"/.exec(firstHtml)?.[1];
  const website = link ? decodeHtml(link) : null;
  const companyName = parts[0].replace(/\(.*?\)/g, '').replace(/https?:\/\/\S+/g, '').trim();
  if (!companyName || companyName.length > 80) return null;
  const role = parts.slice(1).find((p) => ROLE_HINT.test(p)) ?? parts[1];
  const location = parts.slice(1).filter((p) => p !== role && LOC_HINT.test(p)).join(' · ') || null;
  const description = htmlToText(html);
  const remote = /\bremote\b/i.test(first);
  const roleNote = /\b(i'?m|i am)\s+(the\s+)?(cto|ceo|founder|co-?founder|engineering manager|hiring manager|head of engineering|vp of engineering)\b/i.exec(description);
  const contacts: ContactCandidate[] = extractEmails(description).map((email) => ({
    name: `${companyName} hiring team`,
    role: roleNote ? roleNote[3] : 'Poster of the HN hiring thread',
    roleCategory: roleNote ? categorizeRole(roleNote[3]) : 'RECRUITER',
    email,
    source: 'hn_hiring',
    sourceUrl: `https://news.ycombinator.com/item?id=${c.objectID}`,
    confidence: 'VERIFIED',
    sourceType: 'JOB_POSTING',
    verificationStatus: 'PUBLICLY_LISTED',
  }));
  let domain: string | null = null;
  try {
    domain = website ? new URL(website).hostname.replace(/^www\./, '') : null;
  } catch {
    domain = null;
  }
  return {
    provider: 'HN_HIRING',
    externalId: c.objectID,
    url: `https://news.ycombinator.com/item?id=${c.objectID}`,
    title: role.slice(0, 200),
    companyName,
    companyWebsite: website,
    companyDomain: domain && !/news\.ycombinator|ycombinator\.com$|greenhouse|lever|ashbyhq|workable/.test(domain) ? domain : null,
    location: location ?? (remote ? 'Remote' : null),
    remote,
    description,
    postedAt: toDate(c.created_at),
    contacts,
  };
}

export class HnHiringProvider extends FeedProvider {
  readonly kind = 'HN_HIRING' as const;
  async searchJobs(c: JobSearchCriteria): Promise<ProviderJob[]> {
    const stories = await fetchJson<{ hits: Array<{ objectID: string; title: string }> }>('https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=6');
    const story = stories.hits.find((h) => /who is hiring/i.test(h.title));
    if (!story) return [];
    const comments = await fetchJson<{ hits: HnComment[] }>(`https://hn.algolia.com/api/v1/search?tags=comment,story_${story.objectID}&hitsPerPage=1000`);
    const jobs = comments.hits
      .filter((h) => String(h.parent_id) === story.objectID)
      .map(parseHnComment)
      .filter((j): j is ProviderJob => !!j);
    return filterListed(jobs, c);
  }
}

// ─── We Work Remotely (RSS) ──────────────────────────────────────────────────

export function parseWwrRss(xml: string): ProviderJob[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const out: ProviderJob[] = [];
  $('item').each((_, el) => {
    const item = $(el);
    const fullTitle = item.find('title').first().text().trim();
    const [company, ...rest] = fullTitle.split(':');
    const title = rest.join(':').trim();
    if (!company || !title) return;
    const descHtml = item.find('description').first().text();
    const website = /<strong>URL:<\/strong>\s*<a href="([^"]+)"/.exec(descHtml)?.[1] ?? null;
    const region = item.find('region').first().text().trim();
    const skills = item.find('skills').first().text().trim();
    const link = item.find('link').first().text().trim() || item.find('guid').first().text().trim();
    let domain: string | null = null;
    try {
      domain = website ? new URL(website).hostname.replace(/^www\./, '') : null;
    } catch {
      domain = null;
    }
    out.push({
      provider: 'WWR',
      externalId: link || fullTitle,
      url: link || null,
      title,
      companyName: company.trim(),
      companyWebsite: website,
      companyDomain: domain,
      location: `Remote${region ? ` (${region})` : ''}`,
      remote: true,
      employmentType: item.find('type').first().text().trim() || null,
      description: htmlToText(descHtml) + (skills ? `\nSkills: ${skills}` : ''),
      postedAt: toDate(item.find('pubDate').first().text().trim()),
    });
  });
  return out;
}

export class WeWorkRemotelyProvider extends FeedProvider {
  readonly kind = 'WWR' as const;
  async searchJobs(c: JobSearchCriteria): Promise<ProviderJob[]> {
    const feeds = ['remote-back-end-programming-jobs', 'remote-full-stack-programming-jobs', 'remote-devops-sysadmin-jobs'];
    const out: ProviderJob[] = [];
    const errors: string[] = [];
    for (const f of feeds) {
      try {
        const r = await httpFetch(`https://weworkremotely.com/categories/${f}.rss`);
        if (r.status < 400) out.push(...parseWwrRss(r.text));
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    if (!out.length && errors.length) throw new FetchError(errors[0]);
    return filterListed(out, c);
  }
}

export const FEED_PROVIDERS: JobProvider[] = [
  new RemotiveProvider(),
  new HimalayasProvider(),
  new JobicyProvider(),
  new ArbeitnowProvider(),
  new RemoteOkProvider(),
  new HnHiringProvider(),
  new WeWorkRemotelyProvider(),
];
