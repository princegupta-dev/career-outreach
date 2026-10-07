import type { JobProviderKind } from '@prisma/client';

export interface SourceCatalogEntry {
  key: string;
  name: string;
  /** Provider kind when it can be added as a discovery source. */
  provider?: JobProviderKind;
  status: 'supported' | 'needs_config' | 'manual_only';
  access: string;
  /** Config keys a source of this kind needs (Settings → Job discovery sources). */
  config?: string[];
  /** Why automated discovery is not offered, and what to do instead. */
  note?: string;
}

/**
 * Every source the system knows about — including the ones it deliberately does not
 * automate. Shown in Settings so it is clear why e.g. Naukri is "paste a URL/JD only".
 */
export const SOURCE_CATALOG: SourceCatalogEntry[] = [
  { key: 'greenhouse', name: 'Greenhouse boards', provider: 'GREENHOUSE', status: 'supported', access: 'Public Job Board API', config: ['boardToken', 'companyName', 'domain'] },
  { key: 'lever', name: 'Lever boards', provider: 'LEVER', status: 'supported', access: 'Public Postings API', config: ['boardToken', 'companyName', 'domain'] },
  { key: 'ashby', name: 'Ashby boards', provider: 'ASHBY', status: 'supported', access: 'Public Job Board API', config: ['boardToken', 'companyName', 'domain'] },
  { key: 'workable', name: 'Workable boards', provider: 'WORKABLE', status: 'supported', access: 'Public careers widget API', config: ['boardToken', 'companyName', 'domain'] },
  { key: 'recruitee', name: 'Recruitee boards', provider: 'RECRUITEE', status: 'supported', access: 'Public offers API', config: ['boardToken', 'companyName', 'domain'] },
  {
    key: 'career_page',
    name: 'Company career page',
    provider: 'CAREER_PAGE',
    status: 'supported',
    access: 'schema.org JobPosting data the company publishes for search engines (robots.txt respected)',
    config: ['url', 'companyName', 'domain'],
  },
  { key: 'yc', name: 'YC — Work at a Startup', provider: 'YC_JOBS', status: 'supported', access: 'Public job pages on ycombinator.com/jobs (robots.txt allows /jobs)', config: ['paths?'] },
  {
    key: 'web_search',
    name: 'Google / web search',
    provider: 'WEB_SEARCH',
    status: 'needs_config',
    access: 'Google Programmable Search JSON API; hits are read from the original ATS posting',
    config: ['maxQueries?', 'withinDays?'],
    note: 'Set GOOGLE_CSE_API_KEY and GOOGLE_CSE_ID (free tier: 100 queries/day).',
  },
  { key: 'hn', name: 'Hacker News — Who is hiring', provider: 'HN_HIRING', status: 'supported', access: 'Algolia public API' },
  { key: 'wwr', name: 'We Work Remotely', provider: 'WWR', status: 'supported', access: 'Public RSS' },
  { key: 'remotive', name: 'Remotive', provider: 'REMOTIVE', status: 'supported', access: 'Public JSON API' },
  { key: 'himalayas', name: 'Himalayas', provider: 'HIMALAYAS', status: 'supported', access: 'Public JSON API (listing dates can be re-posts — verify on the company board)' },
  { key: 'jobicy', name: 'Jobicy', provider: 'JOBICY', status: 'supported', access: 'Public JSON API' },
  { key: 'remoteok', name: 'Remote OK', provider: 'REMOTEOK', status: 'supported', access: 'Public JSON API' },
  { key: 'arbeitnow', name: 'Arbeitnow', provider: 'ARBEITNOW', status: 'supported', access: 'Public JSON API' },
  {
    key: 'naukri',
    name: 'Naukri',
    status: 'manual_only',
    access: 'No public API; automated access is blocked by bot protection and not permitted',
    note: 'Paste the job description (Jobs → Add job). Many Naukri listings are also on the company’s own ATS board — add that board instead.',
  },
  {
    key: 'wellfound',
    name: 'Wellfound',
    status: 'manual_only',
    access: 'No public API; listings require an account and are protected against automated access',
    note: 'Paste the job description. Startups on Wellfound usually also post on Ashby/Greenhouse/Lever — add that board.',
  },
  {
    key: 'instahyre',
    name: 'Instahyre',
    status: 'manual_only',
    access: 'No public API; job search requires login (automated requests are refused)',
    note: 'Paste the job description.',
  },
  {
    key: 'hirist',
    name: 'Hirist',
    status: 'manual_only',
    access: 'No public API or feed',
    note: 'Import a single public job page by URL (robots.txt is checked) or paste the job description.',
  },
  { key: 'linkedin', name: 'LinkedIn', status: 'manual_only', access: 'Automated access is not permitted', note: 'Paste the job description.' },
];

export function catalogEntry(provider: JobProviderKind): SourceCatalogEntry | undefined {
  return SOURCE_CATALOG.find((e) => e.provider === provider);
}
