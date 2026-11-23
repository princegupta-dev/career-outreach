import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BrowserContext, Page } from 'playwright';
import { parseProfileMarkdown } from '../domain/profile/profile';
import type { StoredFoundJob } from '../results';
import { createNaukriRunner, saveNaukriResume } from './naukri-run';
import { appliedToday, loadLog, record } from './log';
import { confirmsJob, reconcileNaukriConfirmations } from './naukri-confirmation';
import type { Answer } from './answers';

const now = new Date('2026-11-18T08:00:00Z');
const profile = parseProfileMarkdown(`---
name: Sample Engineer
career_start_year: 2020
target_roles: [Backend Engineer]
target_locations: [India, Remote]
skills:
  strong: [Node.js, TypeScript, Redis, MySQL]
---
`, now);
const job = (id: string, over: Partial<StoredFoundJob> = {}): StoredFoundJob => ({
  id, title: 'Senior Backend Engineer', company: id, companyDomain: null, location: 'India', remote: false,
  url: `https://www.naukri.com/job-listings-backend-${id}-1234567890`, postedAt: now.toISOString(), source: 'NAUKRI', salaryText: null, teamSize: null,
  score: 99, recommendation: 'STRONG_APPLY', reasons: [], missingSkills: [], flags: [], contacts: [],
  description: 'Senior Backend Engineer. Requirements: 3+ years of experience. Build backend APIs using Node.js, TypeScript, MySQL and Redis. Location: India.', firstSeenAt: now.toISOString(), lastSeenAt: now.toISOString(), ...over,
});
const confirmation = (title: string) => `<title>Apply Confirmation</title><div class="acp-header-container"><div class="job-title-text">Applied to <span class="job-title">"${title}"</span></div></div>`;

describe('Naukri matching, history and batch execution', () => {
  let dir: string;
  let logFile: string;
  const originalResume = process.env.JOB_HUNTER_NAUKRI_RESUME;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naukri-run-')); logFile = path.join(dir, 'log.json'); process.env.JOB_HUNTER_NAUKRI_RESUME = path.join(dir, 'resume.pdf'); });
  afterEach(() => { if (originalResume === undefined) delete process.env.JOB_HUNTER_NAUKRI_RESUME; else process.env.JOB_HUNTER_NAUKRI_RESUME = originalResume; fs.rmSync(dir, { recursive: true, force: true }); });
  const setup = (jobs: StoredFoundJob[] = [job('a'), job('b')], answers: Answer[] = []) => {
    const close = jest.fn(async () => undefined);
    const browser = { newPage: async () => ({} as Page), close } as unknown as BrowserContext;
    const apply = jest.fn(async (_page: Page, _job: { id: string }, context: { dryRun: boolean; beforeApply?: () => void }) => {
      if (context.dryRun) return { status: 'dry-run' as const };
      context.beforeApply?.();
      expect(loadLog(logFile)[_job.id].status).toBe('verification-required');
      return { status: 'applied' as const };
    });
    const runner = createNaukriRunner({ load: () => ({ updatedAt: now.toISOString(), jobs: Object.fromEntries(jobs.map((j) => [j.id, j])) }), profile: () => profile, book: () => ({ answers, questions: [] }),
      settings: () => ({ autoApply: { naukri: 'on', hirist: 'on', instahyre: 'on' }, minScore: 70, maxPerRun: 15, days: 7 }),
      logFile, open: async () => browser, apply, pause: async () => undefined, now: () => now });
    return { runner, apply, close };
  };
  it('re-scores against the current profile and excludes other boards, wrong-stack jobs, employer sites and stale jobs', () => {
    const { runner } = setup([job('a'), job('hirist', { source: 'HIRIST' }), job('external', { flags: ['apply:company-site'] }), job('old', { postedAt: '2026-10-01' }), job('java', { title: 'Senior Java Developer', description: 'Java and Spring Boot. 7+ years. Build Java services in India.' }), job('bad-url', { url: 'https://example.com/job' }), job('legacy', { description: undefined }), job('python', { title: 'Senior Backend Engineer - FastAPI', description: '3+ years Python experience with FastAPI, Redis and MySQL in India.' })]);
    expect(runner.preview().jobs.map((j) => j.id)).toEqual(['a']);
  });
  it('uses only Naukri, reserves a durable record before Apply, then records verified results', async () => {
    const { runner, apply, close } = setup();
    const preview = runner.preview();
    runner.start('apply', preview.token, preview.options); await runner.settled();
    expect(apply).toHaveBeenCalledTimes(2);
    expect(runner.status()).toMatchObject({ running: false, completed: 2, error: null });
    expect(appliedToday(loadLog(logFile), now)).toBe(2);
    expect(runner.preview().jobs).toHaveLength(0);
    expect(close).toHaveBeenCalled();
  });
  it('does not send during dry runs and rejects a stale preview', async () => {
    const answers: Answer[] = [];
    const { runner } = setup([job('a')], answers);
    const preview = runner.preview();
    answers.push({ match: ['notice'], answer: '30 days', source: 'you' });
    expect(() => runner.start('apply', preview.token, preview.options)).toThrow('changed');
    const updated = runner.preview(); runner.start('dry-run', updated.token, updated.options); await runner.settled();
    expect(loadLog(logFile).a.status).toBe('dry-run'); expect(appliedToday(loadLog(logFile), now)).toBe(0);
  });
  it('respects duplicate and daily limits, including uncertain submissions', () => {
    for (let i = 0; i < 29; i++) record({ jobId: `done-${i}`, company: `done-${i}`, title: 'Engineer', url: `https://www.naukri.com/job-${i}`, at: now.toISOString(), status: i ? 'applied' : 'verification-required' }, logFile);
    const { runner } = setup(); expect(runner.preview()).toMatchObject({ remainingToday: 1, jobs: [expect.objectContaining({ id: 'a' })] });
  });
  it('requires a manual Naukri check to release an uncertain attempt, and never releases a confirmed application', () => {
    const { runner } = setup([job('a')]);
    record({ jobId: 'a', title: job('a').title, company: 'a', url: job('a').url!, at: now.toISOString(), status: 'verification-required' }, logFile);
    expect(runner.preview().jobs).toHaveLength(0); runner.allowRetry('a'); expect(runner.preview().jobs).toHaveLength(1);
    record({ ...loadLog(logFile).a, status: 'applied' }, logFile); expect(() => runner.allowRetry('a')).toThrow('Only an unverified');
  });
  it('retries blocked questions only after confirmed answers change', async () => {
    const answers: Answer[] = [];
    const { runner } = setup([job('a')], answers);
    const initial = runner.preview();
    const fail = createNaukriRunner({ load: () => ({ updatedAt: now.toISOString(), jobs: { a: job('a') } }), profile: () => profile, book: () => ({ answers, questions: [] }), settings: () => ({ autoApply: { naukri: 'on', hirist: 'off', instahyre: 'off' }, minScore: 70, maxPerRun: 15, days: 7 }), logFile,
      open: async () => ({ newPage: async () => ({}), close: async () => undefined }) as unknown as BrowserContext, apply: async () => ({ status: 'needs-answers' }), now: () => now });
    const preview = fail.preview(); fail.start('apply', preview.token, preview.options); await fail.settled();
    expect(runner.preview().jobs).toHaveLength(0);
    answers.push({ match: ['notice'], answer: '30 days', source: 'you' });
    expect(runner.preview().jobs).toHaveLength(1);
    expect(initial.jobs).toHaveLength(1);
  });
  it('validates a PDF before saving it privately', () => {
    expect(() => saveNaukriResume(Buffer.from('not a PDF').toString('base64'))).toThrow('Choose a PDF');
    expect(saveNaukriResume(Buffer.from('%PDF-1.4\nfixture').toString('base64'))).toMatchObject({ uploaded: true });
    expect(fs.statSync(process.env.JOB_HUNTER_NAUKRI_RESUME!).mode & 0o777).toBe(0o600);
  });
  it('collects fresh Naukri jobs without submitting applications', async () => {
    const collect = jest.fn(async () => [job('fresh')]);
    const save = jest.fn(() => ({ updatedAt: now.toISOString(), jobs: {} }));
    const runner = createNaukriRunner({ profile: () => profile, open: async () => ({ close: async () => undefined }) as unknown as BrowserContext, collect, save, now: () => now });
    expect(runner.find(7).mode).toBe('discover'); await runner.settled();
    expect(collect).toHaveBeenCalledTimes(1); expect(save).toHaveBeenCalledWith({ jobs: [job('fresh')], ranAt: now.toISOString() });
    expect(runner.status()).toMatchObject({ running: false, completed: 1, error: null, results: [] });
  });
  it('repairs only exact saved confirmations and preserves the original application date', () => {
    const snapshots = path.join(dir, 'snapshots'); fs.mkdirSync(snapshots);
    const entry = { jobId: 'abcdefghijk', title: 'Backend Engineer', company: 'Example', url: 'https://www.naukri.com/job-listings-example-1234567890', at: '2026-11-17T09:00:00Z', status: 'failed' as const, note: 'Clicked Apply but saw no confirmation' };
    record(entry, logFile);
    fs.writeFileSync(path.join(snapshots, 'apply-naukri-abcdefghij-after-click.html'), confirmation('Different Engineer'));
    expect(reconcileNaukriConfirmations(logFile, snapshots)).toHaveLength(0);
    expect(confirmsJob('<p>Recommended: Applied to Backend Engineer</p>', 'Backend Engineer')).toBe(false);
    fs.writeFileSync(path.join(snapshots, 'apply-naukri-abcdefghij-after-click.html'), confirmation(entry.title));
    expect(reconcileNaukriConfirmations(logFile, snapshots)).toHaveLength(1);
    expect(loadLog(logFile)[entry.jobId]).toMatchObject({ status: 'applied', at: entry.at });
  });
});
