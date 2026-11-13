import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import type { BrowserContext } from 'playwright';
import { openBrowser, readSite } from './runner';
import type { Site } from './sites';

/** Real Chrome against a fake job board on localhost: search page → job pages → JobPosting data. */
const hasChrome = fs.existsSync('/Applications/Google Chrome.app') || fs.existsSync('/usr/bin/google-chrome');
const run = hasChrome ? describe : describe.skip;

const ld = (title: string) =>
  `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title, datePosted: '2026-11-10', description: 'Node.js, PostgreSQL, Redis backend APIs for payments.', hiringOrganization: { name: 'Acme' }, jobLocation: { address: { addressLocality: 'Gurugram' } } })}</script>`;
const PAGES: Record<string, string> = {
  '/search': `<title>Jobs</title><a href="/job/1?trk=a">One</a><a href="/job/2">Two</a><a href="/about">About</a>`,
  '/job/1': `<title>One</title>${ld('Backend Engineer')}`,
  '/job/2': `<title>Two</title>${ld('Node.js Developer')}`,
  '/walled': `<title>Sign in to continue</title>`,
  // Like Naukri: the page loads its job list from a JSON API in the background, then draws the cards.
  '/spa': `<title>Jobs</title><script>
    fetch('/api/search?q=x').then((r) => r.json()).then(() => document.body.insertAdjacentHTML('beforeend', '<a href="/job/9" class="card">card</a>'));
  </script>`,
  '/api/search': JSON.stringify({ jobs: [{ title: 'API Job', company: 'Acme' }] }),
  '/api/page2': JSON.stringify({ jobs: [{ title: 'Page 2 Job', company: 'Beta' }] }),
  // A bot-check page that clears by itself, then renders its job list late (like Cloudflare + a client-side list).
  '/slow': `<title>Just a moment...</title><body><script>
    setTimeout(() => { document.title = 'Jobs'; }, 300);
    setTimeout(() => { document.body.insertAdjacentHTML('beforeend', '<div class="card">Late Job</div>'); }, 800);
  </script></body>`,
};

run('readSite (real Chrome, local pages)', () => {
  let server: http.Server;
  let base = '';
  let ctx: BrowserContext;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-profile-'));
  const site = (searchPath: string): Site => ({
    key: 'fake', name: 'Fake', provider: 'HIRIST', loginUrl: `${base}/login`,
    searchUrls: () => [`${base}${searchPath}`], jobLink: /\/job\/\d+/, isWall: (_u, t) => /sign in/i.test(t),
  });

  beforeAll(async () => {
    server = http.createServer((req, res) => res.end(PAGES[(req.url ?? '').split('?')[0]] ?? '<title>404</title>'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ctx = await openBrowser(true, dir);
  }, 60_000);
  afterAll(async () => {
    await ctx?.close();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('follows job links from the search page and reads each posting', async () => {
    const r = await readSite(ctx, site('/search'), { days: 7, delayMs: [10, 20], now: new Date('2026-11-11') });
    expect(r.error).toBeUndefined();
    expect(r.jobs.map((j) => j.title).sort()).toEqual(['Backend Engineer', 'Node.js Developer']);
    expect(r.jobs[0].url).toMatch(/\/job\/\d$/);
    expect(r.pages).toBe(3);
  }, 60_000);

  it('waits for a bot check to clear and for the list to render, then parses the search page', async () => {
    const s: Site = { ...site('/slow'), ready: '.card', detailPages: false, parseSearch: (html) => (html.includes('Late Job') ? [{ provider: 'HIRIST', title: 'Late Job', companyName: 'Acme', description: 'x' }] : []) };
    const r = await readSite(ctx, s, { days: 7, delayMs: [10, 20] });
    expect(r.error).toBeUndefined();
    expect(r.jobs.map((j) => j.title)).toEqual(['Late Job']);
    expect(r.pages).toBe(1);
  }, 60_000);

  it('reads the job list from the data response the page itself loaded', async () => {
    const s: Site = {
      ...site('/spa'), ready: '.card', detailPages: false, dataUrl: /\/api\/search\?/,
      parseData: (body) => (JSON.parse(body) as { jobs: Array<{ title: string; company: string }> }).jobs.map((j) => ({ provider: 'NAUKRI' as const, title: j.title, companyName: j.company, description: 'x', url: `${base}/job/${j.title}` })),
    };
    const r = await readSite(ctx, s, { days: 7, delayMs: [10, 20] });
    expect(r.error).toBeUndefined();
    expect(r.jobs.map((j) => j.title)).toEqual(['API Job']);
    // More pages fetched from inside the page, like the site's own "load more".
    const paged = await readSite(ctx, { ...s, morePages: ['/api/page2'] }, { days: 7, delayMs: [10, 20] });
    expect(paged.jobs.map((j) => j.title).sort()).toEqual(['API Job', 'Page 2 Job']);
  }, 60_000);

  it('stops at a login wall and says how to log in', async () => {
    const r = await readSite(ctx, site('/walled'), { days: 7, delayMs: [10, 20] });
    expect(r.jobs).toEqual([]);
    expect(r.error).toMatch(/Login or bot-check page \("Sign in to continue"\)\. Run: npm run login -- fake/);
  }, 60_000);
});
