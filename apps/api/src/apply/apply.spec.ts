import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import type { BrowserContext, Page } from 'playwright';
import { loadProfile } from '../domain/__fixtures__/fixtures';
import type { StoredFoundJob } from '../results';
import { openBrowser } from '../browser/runner';
import { Answer, buildAnswers, FACTS, keywordsOf, loadAnswers, matchAnswer, pickOption, rememberQuestion, saveAnswer, unansweredQuestions } from './answers';
import { APPLY_SITES, applyOnSite } from './engine';
import { appliedToday, ApplyLog, isDone } from './log';
import { DAILY_LIMIT, selectJobs } from './select';
import { DEFAULT_SETTINGS, loadSettings } from './settings';

// Files the code under test writes go to a temp folder, never into your real ~/.job-hunter or .cache.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-apply-'));
process.env.JOB_HUNTER_SNAPSHOTS = path.join(tmp, 'snaps');
process.env.JOB_HUNTER_ANSWERS = path.join(tmp, 'answers.json');
process.env.JOB_HUNTER_QUESTIONS = path.join(tmp, 'questions.json');

const profile = loadProfile();
const bank = buildAnswers(profile);
const ask = (q: string) => matchAnswer(q, bank, profile.strongSkills);

describe('question bank (answers from your profile and facts)', () => {
  it('answers the common questions', () => {
    expect(ask('What is your notice period?')).toBe('30 days');
    expect(ask('Notice period (in days)')).toBe('30'); // the more specific entry wins
    expect(ask('What is your current CTC?')).toBe(FACTS.currentCtc);
    expect(ask('Expected salary?')).toBe(FACTS.expectedCtc);
    expect(ask('Expected CTC (in LPA)?')).toBe('17 LPA');
    expect(ask('Total years of experience?')).toBe(String(profile.experienceYears));
    expect(ask('How many years of experience do you have in Node.js?')).toBe(String(profile.experienceYears));
    expect(ask('Are you willing to relocate to Bangalore?')).toBe('Yes');
    expect(ask('Can you join immediately?')).toBe('No');
    expect(ask('Please share your LinkedIn profile URL')).toBe(profile.contact.linkedin);
    expect(ask('Highest qualification')).toBe('B.Tech');
  });

  it('never claims experience in a skill that is not one of your strong skills', () => {
    for (const q of ['Years of experience with Kafka?', 'How many years in Spring Boot?', 'Relevant experience in Elixir', 'Experience with Java and Node.js?']) expect([q, ask(q)]).toEqual([q, null]);
  });

  it('never answers sensitive questions', () => {
    for (const q of ['What is your gender?', 'Date of birth', 'Do you have a disability?']) expect([q, ask(q)]).toEqual([q, null]);
  });

  it('refuses when two equally specific answers disagree', () => {
    const answers: Answer[] = [{ match: ['ctc'], answer: '1' }, { match: ['lpa'], answer: '2' }];
    expect(matchAnswer('CTC in LPA', answers)).toBeNull();
  });
});

describe('pickOption', () => {
  it.each([
    [['Yes', 'No'], 'Yes', 0],
    [['0-1 years', '2-4 years', '5+ years'], '3', 1],
    [['Less than 2', '3 to 5', 'More than 5'], '3', 1],
    [['1', '2', '3', '4+'], '3', 2],
    [['1', '2', '3+'], '7', 2],
    [['Immediate', '15 days', '30 days', '60 days'], '30 days', 2],
    [['Bangalore', 'Pune'], 'Gurugram', -1],
  ])('%j with "%s" → %i', (options, answer, index) => {
    expect(pickOption(options, answer)).toBe(index);
  });
});

describe('unanswered questions → you answer once → answered from then on', () => {
  it('remembers new questions, asks once, then matches them', () => {
    const answers = loadAnswers(profile);
    rememberQuestion('Are you comfortable working from the Gurugram office 5 days a week?', 'Naukri', 'Backend Engineer');
    rememberQuestion('Are you comfortable working from the Gurugram office 5 days a week?', 'Naukri', 'Backend Engineer');
    const open = unansweredQuestions(answers, profile.strongSkills);
    expect(open).toEqual([expect.objectContaining({ site: 'Naukri', times: 2 })]);
    saveAnswer(open[0].question, 'Yes');
    const after = loadAnswers(profile);
    expect(unansweredQuestions(after, profile.strongSkills)).toEqual([]);
    expect(matchAnswer('Are you comfortable working from the Gurugram office 5 days a week?', after, profile.strongSkills)).toBe('Yes');
  });

  it('picks the identifying words of a question', () => {
    expect(keywordsOf('What is your notice period?')).toEqual(['notice', 'period']);
  });

  it('your own answers beat the profile-based ones, even when less specific', () => {
    fs.writeFileSync(process.env.JOB_HUNTER_ANSWERS!, JSON.stringify([{ match: ['node'], answer: '3.7' }]));
    expect(matchAnswer('How many years of experience do you have in Node.js?', loadAnswers(profile), profile.strongSkills)).toBe('3.7');
  });

  it('keeps your edits over the bank', () => {
    fs.writeFileSync(process.env.JOB_HUNTER_ANSWERS!, JSON.stringify([{ match: ['current', 'ctc'], answer: '13.5 LPA', source: 'you' }]));
    expect(matchAnswer('Current CTC?', loadAnswers(profile), profile.strongSkills)).toBe('13.5 LPA');
  });
});

describe('settings (your per-site auto-apply switch)', () => {
  const file = path.join(tmp, 'settings.json');
  it('starts every site in dry-run and writes the file', () => {
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).autoApply.naukri).toBe('dry-run');
  });
  it('ignores invalid values instead of guessing', () => {
    fs.writeFileSync(file, JSON.stringify({ autoApply: { naukri: 'on', hirist: 'yes please' }, minScore: 500, maxPerRun: 10 }));
    expect(loadSettings(file)).toEqual({ ...DEFAULT_SETTINGS, autoApply: { naukri: 'on', hirist: 'dry-run', instahyre: 'dry-run' }, maxPerRun: 10 });
  });
});

const job = (id: string, over: Partial<StoredFoundJob> = {}): StoredFoundJob => ({
  id, title: 'Backend Engineer', company: 'Acme', companyDomain: null, location: 'Gurugram', remote: null, url: `https://www.naukri.com/job-listings-${id}`,
  postedAt: '2026-11-10T00:00:00.000Z', source: 'NAUKRI', salaryText: null, teamSize: null, score: 75, recommendation: 'APPLY', reasons: [], missingSkills: [],
  flags: [], contacts: [], firstSeenAt: '2026-11-10T00:00:00.000Z', lastSeenAt: '2026-11-10T00:00:00.000Z', ...over,
});
const now = new Date('2026-11-11T15:00:00');
const entry = (jobId: string, status: ApplyLog[string]['status'], at = now.toISOString()) => ({ jobId, url: '', title: '', company: '', status, at });
const all = { minScore: 70, max: 10, now, sites: ['naukri', 'hirist', 'instahyre'] as const };

describe('selectJobs', () => {
  it('picks jobs from enabled sites above the score, best first, never ones already done', () => {
    const jobs = [job('a', { score: 72 }), job('b', { score: 90 }), job('low', { score: 60 }), job('wf', { source: 'WELLFOUND' }), job('h', { source: 'HIRIST', score: 80 }), job('done'), job('skip', { recommendation: 'SKIP' }), job('retry')];
    const log: ApplyLog = { done: entry('done', 'applied'), retry: entry('retry', 'failed') };
    expect(selectJobs(jobs, log, { ...all, sites: [...all.sites] }).jobs.map((j) => j.id)).toEqual(['b', 'h', 'retry', 'a']);
    expect(selectJobs(jobs, log, { ...all, sites: ['naukri'] }).jobs.map((j) => j.id)).toEqual(['b', 'retry', 'a']);
  });

  it('skips jobs that apply on the company site', () => {
    expect(selectJobs([job('ext', { flags: ['apply:company-site'] }), job('q', { flags: ['apply:questions'] })], {}, { ...all, sites: ['naukri'] }).jobs.map((j) => j.id)).toEqual(['q']);
  });

  it('never goes over the daily limit, whatever settings say', () => {
    const log: ApplyLog = Object.fromEntries(Array.from({ length: DAILY_LIMIT - 2 }, (_, i) => [`x${i}`, entry(`x${i}`, 'applied')]));
    const r = selectJobs([job('a'), job('b'), job('c')], log, { minScore: 0, max: 50, now, sites: ['naukri'] });
    expect(r.left).toBe(2);
    expect(r.jobs).toHaveLength(2);
  });

  it('counts only real applications since midnight', () => {
    const log: ApplyLog = { a: entry('a', 'applied'), y: entry('y', 'applied', '2026-11-10T10:00:00'), d: entry('d', 'dry-run') };
    expect(appliedToday(log, now)).toBe(1);
    expect(isDone(log, 'd')).toBe(false);
  });
});

/** Real Chrome against fake job pages on localhost. */
const hasChrome = fs.existsSync('/Applications/Google Chrome.app') || fs.existsSync('/usr/bin/google-chrome');
(hasChrome ? describe : describe.skip)('applyOnSite (real Chrome, local pages)', () => {
  const hits: string[] = [];
  const done = `document.body.insertAdjacentHTML('beforeend','<p>You have successfully applied</p>')`;
  const PAGES: Record<string, string> = {
    '/simple': `<title>Job</title><button onclick="fetch('/hit/simple');${done}">Apply</button>`,
    '/already': `<title>Job</title><button disabled>Applied</button>`,
    '/external': `<title>Job</title><button>Apply on company site</button>`,
    '/closed': `<title>Job</title><p>This job is no longer accepting applications</p>`,
    '/text': `<title>Job</title><button onclick="document.getElementById('q').style.display='block'">Apply</button>
      <div id="q" role="dialog" style="display:none"><p>What is your notice period?</p><input id="a"><button onclick="fetch('/hit/'+encodeURIComponent(document.getElementById('a').value));this.parentNode.remove();${done}">Save</button></div>`,
    '/radio': `<title>Job</title><button onclick="document.getElementById('q').style.display='block'">Apply</button>
      <div id="q" role="dialog" style="display:none"><p>How many years of experience do you have in Node.js?</p>
      <label><input type="radio" name="y" value="a" onclick="fetch('/hit/radio-0-1')">0-1 years</label><label><input type="radio" name="y" onclick="fetch('/hit/radio-2-4')">2-4 years</label><label><input type="radio" name="y" onclick="fetch('/hit/radio-5')">5+ years</label>
      <button onclick="this.parentNode.remove();${done}">Next</button></div>`,
    '/select': `<title>Job</title><button onclick="document.getElementById('q').style.display='block'">Apply</button>
      <div id="q" role="dialog" style="display:none"><p>Are you willing to relocate?</p><select id="s"><option>Select</option><option>Yes</option><option>No</option></select>
      <button onclick="fetch('/hit/select-'+document.getElementById('s').value);this.parentNode.remove();${done}">Submit</button></div>`,
    '/unknown': `<title>Job</title><button onclick="document.getElementById('q').style.display='block'">Apply</button>
      <div id="q" role="dialog" style="display:none"><p>Rate your Kafka skills out of 10?</p><input></div>`,
  };
  let server: http.Server;
  let base = '';
  let ctx: BrowserContext;
  let page: Page;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-chrome-'));

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url?.startsWith('/hit/')) hits.push(decodeURIComponent(req.url.slice(5)));
      res.end(PAGES[req.url ?? ''] ?? '');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ctx = await openBrowser(true, dir);
    page = await ctx.newPage();
  }, 60_000);
  afterAll(async () => {
    await ctx?.close();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    hits.length = 0;
  });
  const apply = (p: string, dryRun = false) => applyOnSite(page, APPLY_SITES.naukri, { id: p.slice(1), url: base + p, title: 'Backend Engineer' }, { answers: bank, strongSkills: profile.strongSkills, dryRun });

  it('clicks Apply and sees the confirmation', async () => {
    expect(await apply('/simple')).toEqual({ status: 'applied' });
    expect(hits).toEqual(['simple']);
  }, 30_000);
  it('does not click anything in a dry run', async () => {
    expect((await apply('/simple', true)).status).toBe('dry-run');
    expect(hits).toEqual([]);
  }, 30_000);
  it('recognises jobs already applied to, company-site jobs and closed jobs', async () => {
    expect((await apply('/already')).status).toBe('already-applied');
    expect((await apply('/external')).status).toBe('external');
    expect((await apply('/closed')).status).toBe('no-button');
  }, 60_000);
  it('types a text answer', async () => {
    expect(await apply('/text')).toEqual({ status: 'applied' });
    expect(hits).toEqual(['30 days']);
  }, 30_000);
  it('picks the radio option that contains your years (3 → "2-4 years")', async () => {
    expect(await apply('/radio')).toEqual({ status: 'applied' });
    expect(hits).toEqual(['radio-2-4']);
  }, 30_000);
  it('chooses a dropdown option', async () => {
    expect(await apply('/select')).toEqual({ status: 'applied' });
    expect(hits).toEqual(['select-Yes']);
  }, 30_000);
  it('stops on a question it must not answer, and saves it for npm run answers', async () => {
    const r = await apply('/unknown');
    expect(r.status).toBe('needs-answers');
    expect(r.note).toMatch(/Kafka/);
    expect(JSON.parse(fs.readFileSync(process.env.JOB_HUNTER_QUESTIONS!, 'utf8')).map((q: { question: string }) => q.question)).toContain('Rate your Kafka skills out of 10?');
  }, 30_000);
});
