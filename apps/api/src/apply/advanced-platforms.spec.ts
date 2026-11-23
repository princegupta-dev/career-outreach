import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BrowserContext, Page } from 'playwright';
import { openBrowser } from '../browser/runner';
import { parseProfileMarkdown } from '../domain/profile/profile';
import { applyPlatform } from './platform-engine';
import { applyNaukri, type NaukriContext } from './naukri';
import { planFormAnswers } from './form-answers';
import { applicationUrlKey, atsTarget, boardJobId } from './platforms';

const profile = parseProfileMarkdown(`---
name: Sample Engineer
contact:
  email: sample@example.com
skills:
  strong: [Node.js, TypeScript]
---
`);
const hasChrome = fs.existsSync('/Applications/Google Chrome.app') || fs.existsSync('/usr/bin/google-chrome');
describe('advanced platform identities', () => {
  it('checks LinkedIn and Wellfound posting identities without accepting lookalike domains', () => {
    expect(boardJobId('https://www.linkedin.com/jobs/view/12345/', 'linkedin')).toBe('12345');
    expect(boardJobId('https://www.linkedin.com/jobs/search/?currentJobId=12345', 'linkedin')).toBe('12345');
    expect(boardJobId('https://wellfound.com/jobs/12345-backend', 'wellfound')).toBe('12345');
    expect(boardJobId('https://linkedin.com.evil.com/jobs/view/12345', 'linkedin')).toBeNull();
    expect(applicationUrlKey('https://www.linkedin.com/jobs/view/12345?trk=x')).toBe(applicationUrlKey('https://www.linkedin.com/jobs/search/?currentJobId=12345'));
  });
  it('keeps Workday application routes tied to the tenant, site and posting', () => {
    const url = 'https://acme.wd1.myworkdayjobs.com/External/job/India/Backend_R123';
    expect(atsTarget(url)?.kind).toBe('workday'); expect(applicationUrlKey(url + '/apply/applyManually')).toBe(applicationUrlKey(url));
    expect(atsTarget('https://wd1.myworkdaysite.com/recruiting/acme/jobs/job/India/Backend_R123')?.kind).toBe('workday');
    expect(applicationUrlKey('https://wd1.myworkdaysite.com/recruiting/acme/External/job/India/Backend_R123')).toBe(applicationUrlKey(url));
    expect(atsTarget('https://acme.wd1.myworkdayjobs.com.evil.com/External/job/India/Backend_R123')).toBeNull();
    expect(applicationUrlKey('https://careers.acme.com/apply?jobId=1')).not.toBe(applicationUrlKey('https://careers.acme.com/apply?jobId=2'));
  });
});
(hasChrome ? describe : describe.skip)('Easy Apply, Wellfound, Workday and human handoffs (intercepted fixtures only)', () => {
  let dir: string, context: BrowserContext, page: Page;
  const sent: string[] = [], errors: string[] = [];
  const old = { snapshots: process.env.JOB_HUNTER_SNAPSHOTS, questions: process.env.JOB_HUNTER_QUESTIONS };
  const url = (site: 'linkedin' | 'wellfound' | 'workday' | 'custom' | 'naukri', name: string) => site === 'linkedin' ? `https://www.linkedin.com/jobs/view/12345/?case=${name}` : site === 'wellfound' ? `https://wellfound.com/jobs/12345-backend?case=${name}` : site === 'workday' ? `https://acme.wd1.myworkdayjobs.com/External/job/India/Backend_R123?case=${name}` : site === 'naukri' ? `https://www.naukri.com/job-listings-backend-1234567890?case=${name}` : `https://careers.acme.com/jobs/backend?case=${name}`;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'advanced-platforms-')); process.env.JOB_HUNTER_SNAPSHOTS = path.join(dir, 'snapshots'); process.env.JOB_HUNTER_QUESTIONS = path.join(dir, 'questions.json');
    context = await openBrowser(true, path.join(dir, 'chrome'));
    await context.route('**/*', async (route) => {
      const request = new URL(route.request().url());
      if (request.pathname === '/sent') { sent.push(request.searchParams.get('value')!); return route.fulfill({ body: '{}' }); }
      const name = request.searchParams.get('case') ?? 'simple';
      const success = `<div role="dialog"><h2>Application submitted</h2></div>`;
      const done = `fetch('/sent?value=${name}');document.body.innerHTML=${JSON.stringify(success)}`;
      const form = `<form onsubmit="event.preventDefault();complete()"><label>Full name<input required></label><button>Submit application</button></form>`;
      let html = `<h1>Backend Engineer</h1>${form}<script>function complete(){${done}}</script>`;
      if (name === 'linkedin') html = `<h1>Backend Engineer</h1><button onclick="openForm()">Easy Apply</button><div class="jobs-easy-apply-modal" role="dialog" hidden></div><script>
        let stage=0;const root=document.querySelector('[role=dialog]');
        function openForm(){root.hidden=false;render();}
        function render(){if(stage===0)root.innerHTML='<h2>Contact information</h2><label>Full name<input required></label><button onclick="advance()" aria-label="Continue to next step">Next</button>';if(stage===1)root.innerHTML='<h2>Review application</h2><label><input id="follow" type="checkbox" checked>Follow Acme</label><button onclick="submitApplication()">Submit application</button>';}
        function advance(){fetch('/sent?value=contact:'+root.querySelector('input').value);stage++;render();}
        function submitApplication(){fetch('/sent?value=follow:'+root.querySelector('#follow').checked);root.innerHTML='<h2>Your application was sent to Acme</h2>';}
        </script>`;
      if (name === 'offsite') html = '<h1>Backend Engineer</h1><a href="https://careers.acme.com/jobs/backend">Apply</a>';
      if (name === 'limit') html = '<h1>Backend Engineer</h1><button onclick="document.querySelector(\'p\').hidden=false">Easy Apply</button><p hidden>You’ve reached your Easy Apply limit</p>';
      if (name === 'wellfound') html = `<h1>Backend Engineer at Acme</h1><button onclick="document.querySelector('[role=dialog]').hidden=false;this.remove()">Apply</button><div role="dialog" hidden><label>Application note<textarea required></textarea></label><button onclick="complete()">Send Application</button></div><script>function complete(){fetch('/sent?value='+encodeURIComponent(document.querySelector('textarea').value));document.body.innerHTML=${JSON.stringify(success)};}</script>`;
      if (name === 'review') html = `<h1>Backend Engineer</h1><button onclick="document.querySelector('[role=dialog]').hidden=false">Easy Apply</button><div role="dialog" class="jobs-easy-apply-modal" hidden><h2>Review your application</h2><button onclick="complete()">Submit application</button></div><script>function complete(){${done}}</script>`;
      if (name === 'workday') html = `<h1 data-automation-id="jobPostingHeader">Backend Engineer</h1><button onclick="manual()">Apply</button><div id="wizard"></div><script>function manual(){document.querySelector('#wizard').innerHTML='<button onclick="start()">Apply Manually</button>';document.querySelector('body>button').remove();}function start(){document.querySelector('#wizard').innerHTML='<div data-automation-id="applicationPage"><h2>My information</h2><label>Full name<input required></label><button onclick="review()">Save and Continue</button></div>';}function review(){fetch('/sent?value=name:'+document.querySelector('input').value);document.querySelector('#wizard').innerHTML='<div role="dialog" data-automation-id="applicationPage"><h2>Review</h2><button onclick="complete()">Submit</button></div>';}function complete(){${done}}</script>`;
      if (name === 'login' || name === 'captcha' || name === 'naukri-captcha') html = `<title>${name.includes('captcha') ? 'CAPTCHA' : 'Sign in'}</title><h1>Backend Engineer</h1>${name === 'login' ? '<input type="password">' : '<div data-testid="captcha">Browser verification</div>'}<button onclick="unlock()">Complete manually</button><div id="rest" hidden>${form}</div><script>function unlock(){document.title='Backend Engineer';document.querySelector('input[type=password], [data-testid=captcha]').remove();document.querySelector('#rest').hidden=false;}function complete(){${done}}</script>`;
      if (name === 'custom-widget') html = `<h1>Backend Engineer</h1><button onclick="document.querySelector('form').hidden=false;this.remove()">Open custom form</button>${form.replace('<form ', '<form hidden ')}<script>function complete(){${done}}</script>`;
      if (name === 'unknown') html = `<h1>Backend Engineer</h1><form onsubmit="event.preventDefault();complete()"><label>Have you worked for SpecificCorp?<input required></label><button>Submit application</button></form><script>function complete(){fetch('/sent?value='+document.querySelector('input').value);document.body.innerHTML=${JSON.stringify(success)};}</script>`;
      if (name === 'wrong-handoff') html = '<title>CAPTCHA</title><h1>Backend Engineer</h1><div data-testid="captcha">Verify</div>';
      await route.fulfill({ body: html, contentType: 'text/html' });
    });
    page = await context.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  }, 60000);
  afterAll(async () => { await context?.close(); for (const [key, value] of Object.entries(old)) { const env = key === 'snapshots' ? 'JOB_HUNTER_SNAPSHOTS' : 'JOB_HUNTER_QUESTIONS'; if (value === undefined) delete process.env[env]; else process.env[env] = value; } fs.rmSync(dir, { recursive: true, force: true }); });
  beforeEach(() => { sent.length = 0; errors.length = 0; });
  const ctx = (overrides: Partial<NaukriContext> = {}): NaukriContext => ({ profile, answers: [], resumeText: '', dryRun: false, waitMs: 250, plan: (fields, p, answers, resume, options) => planFormAnswers(fields, p, answers, resume, { ...options, fetcher: async () => new Response('', { status: 503 }) }), ...overrides });
  const apply = (site: 'linkedin' | 'wellfound' | 'workday' | 'custom', name: string, overrides: Partial<NaukriContext> = {}) => applyPlatform(site === 'workday' || site === 'custom' ? 'external' : site, page, { id: name, title: 'Backend Engineer', company: 'Acme', companyDomain: 'acme.com', url: url(site, name) }, ctx(overrides));
  it('completes LinkedIn contact and review steps while opting out of company follows', async () => {
    expect(await apply('linkedin', 'linkedin')).toMatchObject({ status: 'applied' }); expect(sent).toEqual(['contact:Sample Engineer', 'follow:false']); expect(errors).toEqual([]);
  });
  it('handles a LinkedIn review dialog without input fields', async () => { expect((await apply('linkedin', 'review')).status).toBe('applied'); expect(sent).toEqual(['review']); });
  it('leaves LinkedIn employer applications to the company panel', async () => { expect((await apply('linkedin', 'offsite')).status).toBe('external'); expect(sent).toEqual([]); });
  it('stops at LinkedIn limits without retrying', async () => { const result = await apply('linkedin', 'limit'); expect(result.status).toBe('verification-required'); expect(result.note).toMatch(/limit/); expect(sent).toEqual([]); });
  it('sends a Wellfound note from confirmed text and recognizes a company-qualified heading', async () => {
    expect(await apply('wellfound', 'wellfound', { answers: [{ match: ['application', 'note'], answer: 'I build Node.js services.', source: 'you' }] })).toMatchObject({ status: 'applied' }); expect(sent).toEqual(['I build Node.js services.']);
  });
  it('continues a Workday Apply Manually wizard through native fields and review', async () => { expect(await apply('workday', 'workday')).toMatchObject({ status: 'applied' }); expect(sent).toEqual(['name:Sample Engineer', 'workday']); });
  it('resumes an initially unsupported custom portal after the user opens its form', async () => { const handoff = jest.fn(async () => { await page.getByRole('button', { name: 'Open custom form' }).click(); return 'resume' as const; }); expect((await apply('custom', 'custom-widget', { handoff })).status).toBe('applied'); expect(handoff).toHaveBeenCalledTimes(1); expect(sent).toEqual(['custom-widget']); });
  it('fills a custom career form bound to the saved posting', async () => { expect((await apply('custom', 'simple')).status).toBe('applied'); expect(sent).toEqual(['simple']); });
  it.each(['login', 'captcha'])('resumes the same company application after manual %s', async (name) => {
    const reserved = jest.fn(); const handoff = jest.fn(async () => { expect(reserved).toHaveBeenCalled(); await page.getByRole('button', { name: 'Complete manually' }).click(); return 'resume' as const; });
    expect(await apply('workday', name, { beforeApply: reserved, handoff })).toMatchObject({ status: 'applied' }); expect(handoff).toHaveBeenCalledTimes(1); expect(sent).toEqual([name]);
  });
  it('uses newly saved confirmed answers after a handoff', async () => {
    let answers: NaukriContext['answers'] = [];
    const handoff = jest.fn(async () => { answers = [{ match: ['worked', 'specificcorp'], answer: 'No', source: 'you' }]; return 'resume' as const; });
    expect((await apply('custom', 'unknown', { handoff, refreshAnswers: () => answers })).status).toBe('applied'); expect(sent).toEqual(['No']);
  });
  it('keeps skipped handoffs uncertain and never marks a different posting as applied', async () => {
    expect((await apply('workday', 'captcha', { handoff: async () => 'skip' })).status).toBe('verification-required');
    expect((await apply('linkedin', 'wrong-handoff', { handoff: async () => { await page.goto('https://www.linkedin.com/jobs/view/99999/?case=simple'); return 'skip'; } })).status).toBe('verification-required'); expect(sent).toEqual([]);
  });
  it('checks live controls without opening Easy Apply or sending a Wellfound application in dry mode', async () => { expect((await apply('linkedin', 'linkedin', { dryRun: true })).status).toBe('dry-run'); expect((await apply('wellfound', 'wellfound', { dryRun: true })).status).toBe('dry-run'); expect(sent).toEqual([]); });
  it('supports a Naukri CAPTCHA handoff without submitting while verification is visible', async () => {
    const result = await applyNaukri(page, { id: 'naukri', title: 'Backend Engineer', url: url('naukri', 'naukri-captcha') }, ctx({ handoff: async () => 'skip' })); expect(result.status).toBe('verification-required'); expect(sent).toEqual([]);
  });
});
