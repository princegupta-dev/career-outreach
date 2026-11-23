import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import type { AddressInfo } from 'net';
import type { BrowserContext } from 'playwright';
import { openBrowser } from '../browser/runner';
import { parseProfileMarkdown } from '../domain/profile/profile';
import type { FoundJob } from '../search';
import { createApplicationReview } from './review';
import { planFormAnswers } from './form-answers';
import { createServer } from '../main';

const job: FoundJob = { id: 'review-job', title: 'Backend Engineer', company: 'Example', companyDomain: null, location: 'India', remote: true, url: 'https://www.naukri.com/job-listings-test', postedAt: null, source: 'NAUKRI', salaryText: null, teamSize: null, score: 85, recommendation: 'APPLY', reasons: [], missingSkills: [], flags: [], contacts: [], description: 'Build backend services with Redis and BullMQ.' };
const profile = parseProfileMarkdown(`---
name: Sample Engineer
current_company: Profile Employer
contact:
  email: candidate@example.com
  phone: '+91-9999999999'
skills:
  strong: [Node.js, BullMQ, Redis]
---
`);

describe('application review lifecycle', () => {
  it('rejects unsupported hosts before opening a browser, and can cancel a pending launch', async () => {
    let release!: (context: BrowserContext) => void;
    const opened = new Promise<BrowserContext>((resolve) => { release = resolve; });
    const open = jest.fn(async () => opened);
    const review = createApplicationReview({ open });
    expect(() => review.open({ ...job, url: 'https://example.com' })).toThrow('supports saved');
    expect(open).not.toHaveBeenCalled();
    review.open(job);
    expect(() => review.open(job)).toThrow('already open');
    await review.close();
    const close = jest.fn(async () => undefined);
    release({ close } as unknown as BrowserContext);
    await review.settled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(review.status()).toMatchObject({ running: false, phase: 'closed' });
  });
});

const hasChrome = fs.existsSync('/Applications/Google Chrome.app') || fs.existsSync('/usr/bin/google-chrome');
(hasChrome ? describe : describe.skip)('Fill and review in real Chrome with a local application', () => {
  let dir: string;
  let board: http.Server;
  let api: http.Server;
  let context: BrowserContext;
  let review: ReturnType<typeof createApplicationReview>;
  let base: string;
  let apiBase: string;
  let applyClicks = 0;
  const submitted: string[] = [];
  const originalQuestions = process.env.JOB_HUNTER_QUESTIONS;
  const form = `<form action="/submit" method="post">
    <label>Full name<input id="name"></label><label>Email<input id="email" type="email"></label>
    <label>Mobile number<input id="phone" type="tel"></label><label>Current company<input id="company" value="My edited employer"></label>
    <label>Notice period in days<input id="notice" type="number"></label>
    <label>Years of experience in Node.js<input id="years" type="number" step="0.1"></label>
    <fieldset><legend>Are you willing to relocate?</legend><label><input type="radio" name="relocation" value="Yes" onclick="fetch('/submit?automatic=1').catch(()=>{});this.form.submit()">Yes</label><label><input type="radio" name="relocation" value="No">No</label></fieldset>
    <label>Highest degree<select id="degree"><option value="">Select</option><option>BTech</option><option>MTech</option></select></label>
    <label>Describe your relevant project experience<textarea id="project"></textarea></label>
    <label>Expected CTC in LPA<input id="salary" type="number"></label>
    <label>Gender<input id="gender"></label><label>Upload resume<input id="file" type="file"></label>
    <label><input id="consent" type="checkbox">I agree to the privacy policy</label>
    <button id="next" type="button" onclick="fetch('/submit?next=1')">Next</button><button id="submit">Submit application</button>
    </form>`;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-chrome-'));
    process.env.JOB_HUNTER_QUESTIONS = path.join(dir, 'questions.json');
    board = http.createServer((req, res) => {
      if (req.url?.startsWith('/submit')) submitted.push(req.url);
      if (req.url === '/apply-click') applyClicks++;
      res.setHeader('content-type', 'text/html');
      res.end(req.url?.startsWith('/submit') ? '<p>Application sent</p>' : `<title>Application</title><button id="open" onclick="fetch('/apply-click');document.querySelector('#application').hidden=false">Apply</button><div id="application" hidden>${form}</div>`);
    });
    await new Promise<void>((resolve, reject) => { board.once('error', reject); board.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(board.address() as AddressInfo).port}`;
    const typedProfile = { ...profile, education: [{ degree: 'BTech', field: '', institution: '', graduation_year: null }] };
    const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockImplementation(async (url, init) => {
      if (String(url).endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'qwen3:4b', digest: 'test' }] }));
      const payload = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const fields = JSON.parse(payload.messages[1].content).fields as { id: string; label: string }[];
      return new Response(JSON.stringify({ done: true, message: { content: JSON.stringify({ answers: fields.filter((f) => /Describe/.test(f.label)).map((f) => ({ fieldId: f.id, factId: null, evidenceIds: ['resume-2'] })) }) } }));
    });
    review = createApplicationReview({
      open: async () => { context = await openBrowser(true, path.join(dir, 'chrome'), { serviceWorkers: 'block' }); return context; },
      allowTestUrl: (url) => url.startsWith(base + '/'), profile: () => typedProfile,
      resume: () => 'Sample Engineer\n- Built background processing with BullMQ and Redis in production.',
      book: () => ({ answers: [
        { match: ['notice'], answer: '30 days', source: 'you' },
        { match: ['years', 'experience', 'node.js'], answer: '3.5', source: 'you' },
        { match: ['relocate'], answer: 'Yes', source: 'you' },
      ], questions: [] }),
      plan: (fields, p, answers, resume) => planFormAnswers(fields, p, answers, resume, { config: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen3:4b', timeoutMs: 1000 }, fetcher }),
    });
    const saved = { ...job, url: base + '/job', firstSeenAt: '2026-11-17', lastSeenAt: '2026-11-17' };
    api = createServer({ application: review, load: () => ({ updatedAt: '2026-11-17', jobs: { [job.id]: saved } }) });
    await new Promise<void>((resolve, reject) => { api.once('error', reject); api.listen(0, '127.0.0.1', resolve); });
    apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  }, 60000);
  afterAll(async () => {
    await review?.close();
    if (api) { api.closeAllConnections(); await new Promise<void>((resolve) => api.close(() => resolve())); }
    if (board) { board.closeAllConnections(); await new Promise<void>((resolve) => board.close(() => resolve())); }
    if (originalQuestions === undefined) delete process.env.JOB_HUNTER_QUESTIONS; else process.env.JOB_HUNTER_QUESTIONS = originalQuestions;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('opens only after a request, fills verified facts and evidence, blocks submission events, and leaves the session open for review', async () => {
    const opened = await fetch(`${apiBase}/api/application/open?jobId=review-job`, { method: 'POST' });
    expect(opened.status).toBe(202);
    await review.settled();
    expect(applyClicks).toBe(0);
    const page = context.pages().at(-1)!;
    await page.locator('#open').click(); // user opens the form; the autofill service never clicks Apply
    expect(applyClicks).toBe(1);
    const filled = await fetch(`${apiBase}/api/application/fill`, { method: 'POST' });
    expect(filled.status).toBe(202);
    await review.settled();
    expect(review.status()).toMatchObject({ running: true, phase: 'review', paused: true });
    expect(await page.locator('#name').inputValue()).toBe('Sample Engineer');
    expect(await page.locator('#email').inputValue()).toBe('candidate@example.com');
    expect(await page.locator('#phone').inputValue()).toBe('+91-9999999999');
    expect(await page.locator('#company').inputValue()).toBe('My edited employer');
    expect(await page.locator('#notice').inputValue()).toBe('30');
    expect(await page.locator('#years').inputValue()).toBe('3.5');
    expect(await page.locator('input[value="Yes"]').isChecked()).toBe(true);
    expect(await page.locator('#degree').inputValue()).toBe('BTech');
    expect(await page.locator('#project').inputValue()).toBe('Built background processing with BullMQ and Redis in production.');
    expect(await page.locator('#salary').inputValue()).toBe('');
    expect(await page.locator('#gender').inputValue()).toBe('');
    expect(await page.locator('#consent').isChecked()).toBe(false);
    expect(submitted).toEqual([]);
    await page.locator('#submit').click(); // still paused; even a stray click is blocked
    expect(submitted).toEqual([]);
    expect((await fetch(`${apiBase}/api/application/fill`, { method: 'POST' })).status).toBe(409);
    expect((await fetch(`${apiBase}/api/application/resume`, { method: 'POST' })).status).toBe(200);
    const nextResponse = page.waitForResponse((r) => r.url().includes('/submit?next=1'));
    await page.locator('#next').click(); // explicitly handed back to the user
    await nextResponse;
    expect(submitted).toContain('/submit?next=1');
    expect((await fetch(`${apiBase}/api/application/close`, { method: 'POST' })).status).toBe(200);
    expect(review.status().running).toBe(false);
  }, 60000);
});
