import type { ProviderJob } from '../providers/jobs/job-provider.interface';
import type { JobProviderKind } from '../types';
import { parseHiristItemList, parseHiristSearch, parseInstahyreSearch, parseNaukriSearch, parseWellfoundSearch } from './parsers';

/**
 * Job boards read through the user's own logged-in Chrome session (see `npm run login`).
 * URL patterns are what each site used in Nov 2026; check them with `npm run fetch -- 7 --sites=x --snapshot`.
 */
export interface Site {
  key: string;
  name: string;
  provider: JobProviderKind;
  loginUrl: string;
  /** Search pages to read, newest jobs first where the site supports it. */
  searchUrls(keywords: string[], days: number): string[];
  /** Links on a search page that lead to a single job. */
  jobLink: RegExp;
  /** The page is a login/challenge wall instead of results. */
  isWall(url: string, title: string): boolean;
  /** CSS selector that appears once the job list has rendered; the runner waits for it. */
  ready?: string;
  /** Read jobs straight from the search page HTML (when the site does not publish JobPosting data). */
  parseSearch?(html: string, now: Date): ProviderJob[];
  /** false = the search page has everything; do not open job pages (fewer page loads, less risk). */
  detailPages?: boolean;
  /** Needs a visible Chrome window (the site shows its bot check to headless Chrome). */
  headed?: boolean;
  /** The site's own data requests that carry the job list (read from what the browser already received). */
  dataUrl?: RegExp;
  /** More result pages, fetched from inside the logged-in page the way the site's own "load more" does (same cookies). */
  morePages?: string[];
  parseData?(body: string, now: Date): ProviderJob[];
  /** Turn a job link into its clean, stable URL (default: drop the query string). Return null to skip the link. */
  jobUrl?(href: string): string | null;
}

const q = encodeURIComponent;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const wall = (url: string, title: string) =>
  /login|signin|sign-in|authwall|checkpoint|captcha|challenge/i.test(url) || /sign in|log in|captcha|security check|access denied|just a moment/i.test(title);

export const SITES: Site[] = [
  {
    key: 'wellfound',
    name: 'Wellfound',
    provider: 'WELLFOUND',
    loginUrl: 'https://wellfound.com/login',
    searchUrls: () => ['https://wellfound.com/role/l/backend-engineer/india', 'https://wellfound.com/role/r/backend-engineer', 'https://wellfound.com/role/l/node-js-developer/india'],
    jobLink: /wellfound\.com\/jobs\/\d+/,
    isWall: wall,
    ready: 'script#__NEXT_DATA__',
    parseSearch: (html) => parseWellfoundSearch(html),
    detailPages: false,
  },
  {
    key: 'hirist',
    name: 'Hirist',
    provider: 'HIRIST',
    loginUrl: 'https://www.hirist.tech/login',
    searchUrls: (kw) => kw.map((k) => `https://www.hirist.tech/k/${slug(k)}-jobs`),
    jobLink: /hirist\.tech\/j\//,
    isWall: wall,
    ready: '.joblist-card-v2',
    // Run headless, Hirist stopped requesting its job list (seen in snapshots: ads and courses load, jobs never do).
    headed: true,
    // Cards when they rendered (location, skills, date); otherwise the always-present ItemList.
    parseSearch: (html, now) => {
      const cards = parseHiristSearch(html, now);
      return cards.length ? cards : parseHiristItemList(html);
    },
    detailPages: false,
  },
  {
    key: 'instahyre',
    name: 'Instahyre',
    provider: 'INSTAHYRE',
    loginUrl: 'https://www.instahyre.com/login/',
    // Instahyre filters by job function, not free text (a q= parameter is ignored and the landing list is shown).
    // 10 = "Backend Development" (from Instahyre's own /api/v1/job_function list).
    searchUrls: () => ['https://www.instahyre.com/search-jobs/?job_functions=10&years=3'],
    jobLink: /instahyre\.com\/job-\d+/,
    isWall: wall,
    headed: true,
    ready: 'a[href*="/job-"]',
    dataUrl: /instahyre\.com\/api\/v1\/job_search\?/,
    parseData: (body) => parseInstahyreSearch(body),
    morePages: [20, 40].map((o) => `/api/v1/job_search?job_functions=10&years=3&job_type=0&company_size=0&limit=20&offset=${o}`),
    detailPages: false,
  },
  {
    key: 'naukri',
    name: 'Naukri',
    provider: 'NAUKRI',
    loginUrl: 'https://www.naukri.com/nlogin/login',
    searchUrls: (kw, days) => kw.map((k) => `https://www.naukri.com/${slug(k)}-jobs?k=${q(k)}&experience=3&jobAge=${Math.min(days, 30)}`),
    jobLink: /naukri\.com\/job-listings-/,
    isWall: wall,
    // The results page loads its jobs from Naukri's own search API; read that response (title, company, date,
    // experience, salary, skills, description start, and whether Apply goes to the company site or asks questions).
    ready: 'a[href*="job-listings-"]', // job cards appear once the search API has answered
    dataUrl: /naukri\.com\/jobapi\/v3\/search\?/,
    parseData: (body) => parseNaukriSearch(body),
    detailPages: false,
    // Naukri's bot protection (Akamai) refuses headless Chrome with "Access Denied". A visible window is a normal
    // browser; if Naukri still refuses it, Naukri does not allow automated access and we stop there.
    headed: true,
  },
  {
    key: 'indeed',
    name: 'Indeed',
    provider: 'INDEED',
    loginUrl: 'https://secure.indeed.com/auth',
    // fromage=N: posted in the last N days. sort=date: newest first.
    searchUrls: (kw, days) => kw.map((k) => `https://in.indeed.com/jobs?q=${q(k)}&l=India&fromage=${Math.min(days, 14)}&sort=date`),
    jobLink: /indeed\.com\/(viewjob|rc\/clk|pagead\/clk)\?/,
    isWall: wall,
    // Indeed shows its bot check to headless Chrome.
    headed: true,
    // The job is identified by its jk= key; the rest of the link is tracking.
    jobUrl: (href) => {
      const jk = new URL(href).searchParams.get('jk');
      return jk && /^[a-f0-9]{8,}$/i.test(jk) ? `https://in.indeed.com/viewjob?jk=${jk}` : null;
    },
  },
];

/** The lower-risk boards. Naukri and Indeed run only when named explicitly. (LinkedIn is a normal source: public search, no login.) */
export const DEFAULT_SITE_KEYS = ['wellfound', 'hirist', 'instahyre'];

export const SEARCH_KEYWORDS = ['node.js backend developer', 'backend engineer'];

export function sitesByKey(keys: string[]): Site[] {
  const unknown = keys.filter((k) => !SITES.some((s) => s.key === k));
  if (unknown.length) throw new Error(`Unknown site(s): ${unknown.join(', ')}. Known: ${SITES.map((s) => s.key).join(', ')}`);
  return SITES.filter((s) => keys.includes(s.key));
}

/** Keep each job link once, without tracking parameters, up to `max`. */
export function jobLinks(hrefs: string[], site: Site, max: number): string[] {
  const seen = new Set<string>();
  for (const h of hrefs) {
    if (!site.jobLink.test(h)) continue;
    try {
      if (site.jobUrl) {
        const clean = site.jobUrl(h);
        if (clean) seen.add(clean);
      } else {
        const u = new URL(h);
        u.search = '';
        u.hash = '';
        seen.add(u.toString());
      }
    } catch {
      continue;
    }
    if (seen.size >= max) break;
  }
  return [...seen];
}
