import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BrowserContext, Page } from 'playwright';
import type { ProviderJob } from '../providers/jobs/job-provider.interface';
import { parseJobPostings } from './ld-json';
import { jobLinks, SEARCH_KEYWORDS, Site } from './sites';

/**
 * Your own Chrome, with its own profile folder (outside the repo). You log in there once with `npm run login`;
 * the cookies stay on your machine and this code never sees a password.
 * Uses installed Google Chrome (channel 'chrome') so it trusts the same certificates your normal browsing does.
 */
export const PROFILE_DIR = process.env.JOB_HUNTER_CHROME_PROFILE ?? path.join(os.homedir(), '.job-hunter', 'chrome-profile');
/** Read when used (not at import), so tests can point it at a temp folder. */
const snapshotDir = () => process.env.JOB_HUNTER_SNAPSHOTS ?? path.resolve(__dirname, '../../.cache/snapshots');

export async function openBrowser(headless: boolean, profileDir = PROFILE_DIR): Promise<BrowserContext> {
  const { chromium } = await import('playwright');
  fs.mkdirSync(profileDir, { recursive: true });
  return chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless,
    viewport: { width: 1280, height: 900 },
    // Playwright passes --use-mock-keychain, which makes Chrome ignore the macOS keychain. Then it does not trust
    // certificates your Mac trusts (e.g. an antivirus or office proxy that inspects HTTPS) and refuses sites your
    // normal Chrome opens fine. Dropping the flag gives it exactly your normal Chrome's trust; it trusts nothing extra.
    ignoreDefaultArgs: ['--use-mock-keychain'],
  });
}

/**
 * Wait for the page to be usable: a bot check page (e.g. Cloudflare "Just a moment...") is given time to clear
 * on its own, then the job list is given time to render. Nothing here tries to get around a check.
 */
async function settle(page: Page, ready?: string): Promise<void> {
  // This function body runs inside the page, where `document` exists.
  await page.waitForFunction(() => !/just a moment/i.test((globalThis as unknown as { document: { title: string } }).document.title), undefined, { timeout: 20_000 }).catch(() => undefined);
  if (ready) await page.waitForSelector(ready, { timeout: 15_000, state: 'attached' }).catch(() => undefined);
}

/** A human-ish pause between page loads: low volume is the whole point. */
const pause = (min: number, max: number) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));

async function readPage(page: Page): Promise<{ scripts: string[]; hrefs: string[]; title: string; url: string }> {
  const scripts = await page.$$eval('script[type="application/ld+json"]', (els) => els.map((e) => e.textContent ?? ''));
  const hrefs = await page.$$eval('a[href]', (els) => els.map((a) => (a as unknown as { href: string }).href));
  return { scripts, hrefs, title: await page.title(), url: page.url() };
}

export interface SiteRun {
  site: string;
  jobs: ProviderJob[];
  pages: number;
  error?: string;
}

/**
 * Read one site: its search pages, then up to `maxJobs` job pages. Read-only: it never clicks Apply,
 * never sends a message, never fills a form. `snapshot` saves each page's HTML so the extractor can be tuned.
 */
export async function readSite(
  ctx: BrowserContext,
  site: Site,
  opts: { days: number; maxJobs?: number; snapshot?: boolean; now?: Date; keywords?: string[]; delayMs?: [number, number] },
): Promise<SiteRun> {
  const page = await ctx.newPage();
  const wait = () => pause(...(opts.delayMs ?? [3000, 7000]));
  const jobs = new Map<string, ProviderJob>();
  let pages = 0;
  const save = async (name: string) => {
    if (!opts.snapshot) return;
    fs.mkdirSync(snapshotDir(), { recursive: true });
    fs.writeFileSync(path.join(snapshotDir(), `${site.key}-${name}.html`), await page.content());
  };
  // In snapshot mode, also keep the JSON the page itself received (to find where a site's job data comes from).
  let xhr = 0;
  const onResponse = async (res: import('playwright').Response) => {
    if (!opts.snapshot || xhr >= 15 || !/json/.test(res.headers()['content-type'] ?? '')) return;
    try {
      const body = await res.text();
      fs.mkdirSync(snapshotDir(), { recursive: true });
      fs.writeFileSync(path.join(snapshotDir(), `${site.key}-xhr-${xhr++}.json`), JSON.stringify({ url: res.url(), body: body.slice(0, 200_000) }));
    } catch {
      // response gone (navigation); not important
    }
  };
  page.on('response', onResponse);
  // Job lists the site loads in the background (e.g. Naukri's search API): parse the body the browser received.
  const data: Promise<void>[] = [];
  const onData = (res: import('playwright').Response) => {
    if (!site.dataUrl || !site.parseData || !site.dataUrl.test(res.url())) return;
    data.push(
      res
        .text()
        .then((body) => add(site.parseData!(body, opts.now ?? new Date())))
        .catch(() => undefined),
    );
  };
  page.on('response', onData);
  const add = (list: ProviderJob[]) => list.forEach((j) => jobs.set(j.url ?? `${j.companyName}|${j.title}`, j));
  try {
    const links: string[] = [];
    for (const [i, url] of site.searchUrls(opts.keywords ?? SEARCH_KEYWORDS, opts.days).entries()) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page, site.ready);
      pages++;
      await save(`search-${i}`);
      const r = await readPage(page);
      if (site.isWall(r.url, r.title)) return { site: site.name, jobs: [...jobs.values()], pages, error: `Login or bot-check page ("${r.title.slice(0, 40)}"). Run: npm run login -- ${site.key}` };
      add(parseJobPostings(r.scripts, site.provider, r.url, opts.now));
      if (site.parseSearch) add(site.parseSearch(await page.content(), opts.now ?? new Date()));
      await Promise.all(data);
      links.push(...r.hrefs);
      await wait();
    }
    const detail = site.detailPages === false ? [] : jobLinks(links, site, opts.maxJobs ?? 15).filter((u) => !jobs.has(u));
    for (const [i, url] of detail.entries()) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page);
      pages++;
      if (i < 3) await save(`job-${i}`);
      const r = await readPage(page);
      if (site.isWall(r.url, r.title)) break;
      add(parseJobPostings(r.scripts, site.provider, url, opts.now));
      await wait();
    }
    return { site: site.name, jobs: [...jobs.values()], pages };
  } catch (e) {
    return { site: site.name, jobs: [...jobs.values()], pages, error: (e as Error).message.split('\n')[0].slice(0, 200) };
  } finally {
    await page.close();
  }
}
