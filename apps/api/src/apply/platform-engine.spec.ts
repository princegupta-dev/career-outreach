import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BrowserContext, Page } from 'playwright';
import { openBrowser } from '../browser/runner';
import { parseProfileMarkdown } from '../domain/profile/profile';
import { applyPlatform } from './platform-engine';
import { applicationUrlKey, atsTarget, boardJobId, publicHttps } from './platforms';
import type { Answer } from './answers';
import { planFormAnswers } from './form-answers';

describe('application destination validation', () => {
  it('accepts exact platform hosts and posting identities, rejecting lookalikes and private URLs', () => {
    expect(boardJobId('https://www.hirist.tech/j/company-backend-12345', 'hirist')).toBe('12345');
    expect(boardJobId('https://www.instahyre.com/job-12345-backend-at-acme/', 'instahyre')).toBe('12345');
    expect(boardJobId('https://www.hirist.tech.evil.com/j/company-12345', 'hirist')).toBeNull();
    for (const url of ['http://careers.acme.com/job', 'https://localhost/job', 'https://127.0.0.1/job', 'https://10.0.0.1/job', 'https://user:pass@careers.acme.com/job', 'https://careers.acme.com:444/job']) expect(publicHttps(url)).toBeNull();
  });
  it('recognizes the same ATS job through application routes and embedded forms', () => {
    expect(atsTarget('https://job-boards.greenhouse.io/acme/jobs/123')).toEqual({ kind: 'greenhouse', key: 'acme/123' });
    expect(applicationUrlKey('https://boards.greenhouse.io/embed/job_app?for=123&token=acme')).toBe(applicationUrlKey('https://job-boards.greenhouse.io/acme/jobs/123?source=linkedin'));
    expect(atsTarget('https://jobs.ashbyhq.com/acme/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/application')?.kind).toBe('ashby');
    expect(atsTarget('https://jobs.lever.co.evil.com/acme/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBeNull();
  });
});

const profile = parseProfileMarkdown(`---
name: Sample Engineer
contact:
  email: sample@example.com
skills:
  strong: [Node.js, TypeScript]
---
`);
const answers: Answer[] = [{ match: ['notice', 'period'], answer: '30 days', source: 'you' }];
const hasChrome = fs.existsSync('/Applications/Google Chrome.app') || fs.existsSync('/usr/bin/google-chrome');
(hasChrome ? describe : describe.skip)('Hirist, Instahyre and company forms in Chrome (intercepted fixtures)', () => {
  let dir: string, browser: BrowserContext, page: Page;
  const sent: string[] = [];
  const original = { snapshots: process.env.JOB_HUNTER_SNAPSHOTS, questions: process.env.JOB_HUNTER_QUESTIONS };
  const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const url = (host: string, slug: string) => `https://${host}/${host.includes('hirist') ? `j/${slug}-123456` : host.includes('instahyre') ? `job-123456-${slug}/` : host.includes('greenhouse') ? `${slug}/jobs/123456` : `${slug}/${uuid}`}`;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-forms-'));
    process.env.JOB_HUNTER_SNAPSHOTS = path.join(dir, 'snapshots'); process.env.JOB_HUNTER_QUESTIONS = path.join(dir, 'questions.json');
    browser = await openBrowser(true, path.join(dir, 'chrome'));
    await browser.route('**/*', async (route) => {
      const request = new URL(route.request().url());
      if (request.pathname === '/sent') { sent.push(request.searchParams.get('value')!); return route.fulfill({ body: '{}' }); }
      if (request.pathname === '/candidate/opportunities/') {
        const completion = '<div class="candidate-apply-all-modal"><div class="modal-info-panel"><p>Application sent to Acme. There are some other jobs at Acme that match your profile.</p></div><button onclick="fetch(\'/sent?value=WRONG\')">Apply to 3 jobs</button></div>';
        return route.fulfill({ contentType: 'text/html', body: `<title>Opportunities</title><input id="skills-drop-select-job-search-selectized"><div class="selectize-dropdown"><div class="create" data-selectable>Add Backend Engineer</div></div><button onclick="document.querySelector('#employer-profile-opportunity').hidden=false">Search</button><a id="employer-profile-opportunity" hidden><div class="employer-job-name" title="Acme - Backend Engineer"></div><ul id="job-skills-123456"></ul><button onclick="document.querySelector('.candidate-apply-modal').hidden=false">View job »</button></a><div class="candidate-apply-modal" hidden><h1>Backend Engineer</h1><h2 class="company-name">Acme</h2><button onclick="complete()">Apply</button></div><script>function complete(){fetch('/sent?value=workspace');document.body.innerHTML=${JSON.stringify(completion)};}</script>` });
      }
      const slug = request.pathname.split('/')[1] === 'j' ? request.pathname.split('/')[2].replace(/-123456$/, '') : request.pathname.split('/')[1].startsWith('job-') ? request.pathname.split('/')[1].replace(/^job-123456-/, '') : request.pathname.split('/')[1];
      const done = `fetch('/sent?value='+encodeURIComponent(this.querySelector('input')?.value||'quick'));document.body.innerHTML='<h2>Application submitted</h2>'`;
      const form = `<form onsubmit="event.preventDefault();${done}"><label>Full name<input required></label><label>Notice period in days<input type="number" required></label><button>Submit application</button></form>`;
      let html = `<title>Backend Engineer</title><h1>Backend Engineer</h1><button onclick="fetch('/sent?value=quick');document.body.innerHTML='<h2>Application submitted</h2>'">Apply</button>`;
      if (slug === 'tracked') html += '<button data-track="apply-job" onclick="fetch(\'/sent?value=tracked\');document.body.innerHTML=\'<h2>Application submitted</h2>\'">Apply</button><button data-track="apply-job">Apply</button>';
      if (slug === 'form') html = `<h1>Backend Engineer</h1>${form}`;
      if (slug === 'screening') html = `<h1>Backend Engineer</h1><button onclick="this.remove();document.querySelector('form').hidden=false">Apply</button>${form.replace('<form ', '<form hidden ')}`;
      if (slug === 'unknown') html = `<h1>Backend Engineer</h1><form><label>Have you worked for UnknownCorp?<input required></label><button>Submit application</button></form>`;
      if (slug === 'optional') html = `<h1>Backend Engineer</h1>${form.replace('<button>', '<label>Gender<select><option value="">Select</option><option>Male</option><option>Female</option></select></label><button>')}`;
      if (slug === 'workspace') html = '<h1>Backend Engineer</h1><h2>Acme</h2>';
      if (slug === 'consent') html = `<h1>Backend Engineer</h1><form><label><input type="checkbox" required>I agree to the privacy policy</label><button>Submit application</button></form>`;
      if (slug === 'captcha') html = '<title>CAPTCHA security check</title><h1>Backend Engineer</h1><button>Apply</button>';
      if (slug === 'wrong') html = '<h1>Java Architect</h1><button>Apply</button>';
      if (slug === 'uncertain') html = '<h1>Backend Engineer</h1><button>Apply</button>';
      if (slug === 'bulk') html = '<h1>Backend Engineer</h1><button onclick="this.remove();document.querySelector(\'[role=dialog]\').hidden=false">Apply</button><div role="dialog" hidden>Apply to other matching jobs<button onclick="fetch(\'/sent?value=WRONG\')">Apply</button></div>';
      if (slug === 'redirect') html = '<h1>Backend Engineer</h1><script>location.replace("/j/another-999999")</script>';
      if (slug === 'linked') html = `<h1>Backend Engineer</h1><a href="${url('job-boards.greenhouse.io', 'form')}">Apply</a>`;
      if (slug === 'embed') html = `<h1>Backend Engineer</h1><iframe src="${url('job-boards.greenhouse.io', 'form')}"></iframe>`;
      if (slug === 'ambiguous') html = `<h1>Backend Engineer</h1><a href="${url('job-boards.greenhouse.io', 'form')}">Apply</a><a href="${url('jobs.lever.co', 'form')}">Apply</a>`;
      if (slug === 'application-route') html = request.pathname.endsWith('/application') ? `<h1>Backend Engineer</h1>${form}` : `<h1>Backend Engineer</h1><a href="${request.pathname}/application"><button>Apply for this Job</button></a>`;
      if (slug === 'already') html = '<h1>Backend Engineer</h1><button disabled>Applied</button>';
      if (slug === 'fake-success') html = '<h1>Backend Engineer</h1><p>Our product shows Application submitted on its user dashboard.</p><button>Apply</button>';
      await route.fulfill({ body: html, contentType: 'text/html' });
    });
    page = await browser.newPage();
  }, 60000);
  afterAll(async () => { await browser?.close(); for (const [key, value] of Object.entries(original)) { const name = key === 'snapshots' ? 'JOB_HUNTER_SNAPSHOTS' : 'JOB_HUNTER_QUESTIONS'; if (value === undefined) delete process.env[name]; else process.env[name] = value; } fs.rmSync(dir, { recursive: true, force: true }); });
  beforeEach(() => { sent.length = 0; });
  const apply = (platform: 'hirist' | 'instahyre' | 'external', host: string, slug: string, dryRun = false, beforeApply = jest.fn()) => applyPlatform(platform, page, { id: slug, title: 'Backend Engineer', company: 'Acme', url: url(host, slug) }, { profile, answers, resumeText: '', dryRun, waitMs: 700, beforeApply, plan: (fields, p, bank, resume, options) => planFormAnswers(fields, p, bank, resume, { ...options, fetcher: async () => new Response('', { status: 503 }) }) });
  it.each(['hirist', 'instahyre'] as const)('submits and verifies a %s quick application', async (platform) => {
    const before = jest.fn(); const result = await apply(platform, platform === 'hirist' ? 'www.hirist.tech' : 'www.instahyre.com', 'quick', false, before);
    expect(result.status).toBe('applied'); expect(sent).toEqual(['quick']); expect(before).toHaveBeenCalledTimes(1);
  });
  it('uses the current-posting Hirist data-track control despite duplicate sticky controls', async () => { expect((await apply('hirist', 'www.hirist.tech', 'tracked')).status).toBe('applied'); expect(sent).toEqual(['tracked']); });
  it('handles screening forms after board Apply', async () => { expect((await apply('instahyre', 'www.instahyre.com', 'screening')).status).toBe('applied'); expect(sent).toEqual(['Sample Engineer']); });
  it('finds the exact Instahyre job through candidate search and ignores additional-company Apply', async () => { expect(await apply('instahyre', 'www.instahyre.com', 'workspace')).toMatchObject({ status: 'applied' }); expect(sent).toEqual(['workspace']); });
  it.each(['job-boards.greenhouse.io', 'jobs.lever.co', 'jobs.ashbyhq.com'])('fills and submits a supported %s application', async (host) => { expect((await apply('external', host, 'form')).status).toBe('applied'); expect(sent).toEqual(['Sample Engineer']); });
  it('follows an Ashby application link containing a nested button', async () => { expect((await apply('external', 'jobs.ashbyhq.com', 'application-route')).status).toBe('applied'); expect(sent).toEqual(['Sample Engineer']); });
  it.each(['linked', 'embed'])('resolves a company %s to its exact ATS application', async (slug) => { expect((await apply('external', 'careers.acme.com', slug)).status).toBe('applied'); expect(sent).toEqual(['Sample Engineer']); });
  it.each(['unknown', 'consent'])('does not submit a form with an unconfirmed %s answer', async (slug) => { expect((await apply('external', 'job-boards.greenhouse.io', slug)).status).toBe('needs-answers'); expect(sent).toEqual([]); });
  it('leaves optional sensitive questions blank without blocking a valid ATS form', async () => { expect((await apply('external', 'job-boards.greenhouse.io', 'optional')).status).toBe('applied'); expect(sent).toEqual(['Sample Engineer']); });
  it('does not submit when the durable history check rejects the destination', async () => { expect((await apply('external', 'job-boards.greenhouse.io', 'form', false, jest.fn(() => { throw new Error('Already applied'); }))).status).toBe('failed'); expect(sent).toEqual([]); });
  it('keeps dry checks non-submitting', async () => { expect((await apply('hirist', 'www.hirist.tech', 'quick', true)).status).toBe('dry-run'); expect((await apply('external', 'jobs.ashbyhq.com', 'form', true)).status).toBe('dry-run'); expect(sent).toEqual([]); });
  it('rejects title changes, listing redirects, challenges and ambiguous employer links', async () => {
    expect((await apply('hirist', 'www.hirist.tech', 'wrong')).status).toBe('no-button');
    expect((await apply('hirist', 'www.hirist.tech', 'redirect')).status).toBe('no-button');
    expect((await apply('instahyre', 'www.instahyre.com', 'captcha')).status).toBe('failed');
    expect((await apply('external', 'careers.acme.com', 'ambiguous')).status).toBe('external'); expect(sent).toEqual([]);
  });
  it('never opts into additional-employer bulk applications', async () => { expect((await apply('instahyre', 'www.instahyre.com', 'bulk')).status).toBe('verification-required'); expect(sent).toEqual([]); });
  it('reserves uncertain applications and ignores success text in job descriptions', async () => { expect((await apply('hirist', 'www.hirist.tech', 'uncertain')).status).toBe('verification-required'); expect((await apply('instahyre', 'www.instahyre.com', 'fake-success')).status).toBe('verification-required'); expect(sent).toEqual([]); });
  it('recognizes an existing confirmed application', async () => { expect((await apply('instahyre', 'www.instahyre.com', 'already')).status).toBe('already-applied'); expect(sent).toEqual([]); });
});
