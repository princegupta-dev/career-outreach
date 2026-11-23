import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import type { BrowserContext } from 'playwright';
import { parseProfileMarkdown } from '../domain/profile/profile';
import type { StoredFoundJob } from '../results';
import { createNaukriRunner } from './naukri-run';
import { loadLog } from './log';
import { loadSettings } from './settings';
import type { NaukriContext } from './naukri';

const now = new Date('2026-11-18T08:00:00Z');
const profile = parseProfileMarkdown(`---
name: Sample Engineer
career_start_year: 2020
target_roles: [Backend Engineer]
target_locations: [India]
skills:
  strong: [Node.js, TypeScript, Redis, MySQL]
---
`, now);
const job: StoredFoundJob = { id: 'linked', title: 'Senior Backend Engineer', company: 'Acme', companyDomain: 'acme.com', location: 'India', remote: false, url: 'https://www.linkedin.com/jobs/view/12345', postedAt: now.toISOString(), source: 'LINKEDIN', salaryText: null, teamSize: null, score: 99, recommendation: 'STRONG_APPLY', reasons: [], missingSkills: [], flags: [], contacts: [], description: 'Senior Backend Engineer. Requirements: 3+ years of experience. Build APIs with Node.js, TypeScript, MySQL and Redis. India.', firstSeenAt: now.toISOString(), lastSeenAt: now.toISOString() };
describe('durable manual handoff runs', () => {
  let dir: string;
  const oldSettings = process.env.JOB_HUNTER_SETTINGS;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-run-')); process.env.JOB_HUNTER_SETTINGS = path.join(dir, 'settings.json'); });
  afterEach(() => { if (oldSettings === undefined) delete process.env.JOB_HUNTER_SETTINGS; else process.env.JOB_HUNTER_SETTINGS = oldSettings; fs.rmSync(dir, { recursive: true, force: true }); });
  function setup() {
    const events = new EventEmitter(), logFile = path.join(dir, 'log.json');
    const close = jest.fn(async () => { events.emit('close'); });
    const browser = { newPage: async () => ({}), close, on: events.on.bind(events) } as unknown as BrowserContext;
    let context: NaukriContext | null = null;
    const runner = createNaukriRunner({ platform: 'linkedin', now: () => now, profile: () => profile, load: () => ({ jobs: { linked: job }, updatedAt: now.toISOString() }), book: () => ({ answers: [], questions: [] }), settings: () => ({ autoApply: { naukri: 'off', hirist: 'off', instahyre: 'off', linkedin: 'on' }, minScore: 70, maxPerRun: 1, days: 7 }), logFile, open: async () => browser,
      apply: async (_page, _job, ctx) => { context = ctx; ctx.beforeApply?.(_job.url); const action = await ctx.handoff!({ reason: 'login', message: 'Complete login in Chrome', url: 'https://www.linkedin.com/login?privateToken=never-expose' }); return { status: action === 'resume' ? 'applied' : 'verification-required' }; },
    });
    return { runner, close, events, logFile, context: () => context };
  }
  async function waiting(runner: ReturnType<typeof createNaukriRunner>) {
    for (let i = 0; i < 20 && !runner.status().handoff; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runner.status().handoff).toBeTruthy(); return runner.status().handoff!;
  }
  it('keeps the same browser and a durable reservation until the current one-time handoff resumes', async () => {
    const { runner, close, logFile } = setup(); const p = runner.preview(); runner.start('apply', p.token, p.options);
    const handoff = await waiting(runner); expect(close).not.toHaveBeenCalled(); expect(loadLog(logFile).linked.status).toBe('verification-required'); expect(handoff.url).toBe('https://www.linkedin.com/login');
    expect(() => runner.continue('stale', 'resume')).toThrow('no longer active');
    runner.continue(handoff.token, 'resume'); expect(() => runner.continue(handoff.token, 'resume')).toThrow('no longer active'); await runner.settled();
    expect(loadLog(logFile).linked.status).toBe('applied'); expect(runner.status()).toMatchObject({ running: false, completed: 1, handoff: null }); expect(close).toHaveBeenCalledTimes(1);
  });
  it('keeps skipped and stopped manual applications in verification history, blocking restart duplicates', async () => {
    const { runner, logFile } = setup(); const p = runner.preview(); runner.start('apply', p.token, p.options); const h = await waiting(runner); runner.continue(h.token, 'skip'); await runner.settled();
    expect(loadLog(logFile).linked.status).toBe('verification-required'); expect(setup().runner.preview().jobs).toHaveLength(0);
  });
  it('stops a pending handoff without hanging or accepting a later resume', async () => {
    const { runner, close, logFile } = setup(); const p = runner.preview(); runner.start('apply', p.token, p.options); const h = await waiting(runner); await runner.stop(); await runner.settled();
    expect(close).toHaveBeenCalled(); expect(loadLog(logFile).linked.status).toBe('verification-required'); expect(runner.status().handoff).toBeNull(); expect(() => runner.continue(h.token, 'resume')).toThrow('no longer active');
  });
  it('releases a pending wait if the user closes Chrome', async () => {
    const { runner, events, logFile } = setup(); const p = runner.preview(); runner.start('apply', p.token, p.options); await waiting(runner); events.emit('close'); await runner.settled();
    expect(runner.status().running).toBe(false); expect(loadLog(logFile).linked.status).toBe('verification-required');
  });
  it('loads independent LinkedIn and Wellfound modes while preserving older settings', () => {
    const file = path.join(dir, 'modes.json'); fs.writeFileSync(file, JSON.stringify({ autoApply: { linkedin: 'on', wellfound: 'dry-run', naukri: 'on' } }));
    expect(loadSettings(file).autoApply).toMatchObject({ linkedin: 'on', wellfound: 'dry-run', naukri: 'on', hirist: 'dry-run' });
  });
});
