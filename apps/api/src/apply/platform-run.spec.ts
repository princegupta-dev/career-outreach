import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import type { BrowserContext, Page } from 'playwright';
import { createNaukriRunner } from './naukri-run';
import { loadSettings } from './settings';
import { loadLog, record } from './log';
import { parseProfileMarkdown } from '../domain/profile/profile';
import type { StoredFoundJob } from '../results';
import type { ApplicationPlatform } from './platforms';
import { createServer } from '../main';

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
const job = (id: string, platform: ApplicationPlatform, overrides: Partial<StoredFoundJob> = {}): StoredFoundJob => ({
  id, title: 'Senior Backend Engineer', company: id, companyDomain: 'acme.com', location: 'India', remote: false,
  url: platform === 'external' ? `https://job-boards.greenhouse.io/${id}/jobs/123456` : platform === 'hirist' ? `https://www.hirist.tech/j/${id}-123456` : platform === 'instahyre' ? `https://www.instahyre.com/job-123456-${id}/` : `https://www.naukri.com/job-listings-${id}-1234567890`,
  postedAt: now.toISOString(), source: platform === 'external' ? 'GREENHOUSE' : platform.toUpperCase(), salaryText: null, teamSize: null, score: 99, recommendation: 'STRONG_APPLY', reasons: [], missingSkills: [], flags: [], contacts: [], description: 'Senior Backend Engineer. Requirements: 3+ years of experience. Build backend APIs using Node.js, TypeScript, MySQL and Redis. India.', firstSeenAt: now.toISOString(), lastSeenAt: now.toISOString(), ...overrides,
});
describe('multi-platform application runs and API', () => {
  let dir: string;
  const original = process.env.JOB_HUNTER_SETTINGS;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-run-')); process.env.JOB_HUNTER_SETTINGS = path.join(dir, 'settings.json'); });
  afterEach(() => { if (original === undefined) delete process.env.JOB_HUNTER_SETTINGS; else process.env.JOB_HUNTER_SETTINGS = original; fs.rmSync(dir, { recursive: true, force: true }); });
  function setup(platform: ApplicationPlatform, jobs = [job('a', platform)]) {
    const logFile = path.join(dir, 'log.json');
    const apply = jest.fn(async (_page: Page, _job: { id: string; url: string }, context: { dryRun: boolean; beforeApply?: (url?: string) => void }) => {
      if (context.dryRun) return { status: 'dry-run' as const };
      context.beforeApply?.(_job.url);
      expect(loadLog(logFile)[_job.id].status).toBe('verification-required');
      return { status: 'applied' as const };
    });
    const load = () => ({ updatedAt: now.toISOString(), jobs: Object.fromEntries(jobs.map((j) => [j.id, j])) });
    const settings = () => ({ ...loadSettings(process.env.JOB_HUNTER_SETTINGS), autoApply: { naukri: 'on' as const, hirist: 'on' as const, instahyre: 'on' as const, external: 'on' as const } });
    const runner = createNaukriRunner({ platform, load, profile: () => profile, book: () => ({ answers: [], questions: [] }), settings, logFile, apply, open: async () => ({ newPage: async () => ({}), close: async () => undefined }) as unknown as BrowserContext, pause: async () => undefined, now: () => now, collect: async () => jobs, save: jest.fn() });
    return { runner, apply, logFile, load };
  }
  it.each(['hirist', 'instahyre', 'external'] as const)('previews, reserves and records only %s jobs', async (platform) => {
    const { runner, apply, logFile } = setup(platform, [job('a', platform), job('other', 'naukri')]);
    const p = runner.preview(); expect(p.jobs.map((j) => j.id)).toEqual(['a']);
    runner.start('apply', p.token, p.options); await runner.settled();
    expect(apply).toHaveBeenCalledTimes(1); expect(loadLog(logFile).a).toMatchObject({ platform, status: 'applied' }); expect(runner.preview().jobs).toHaveLength(0);
  });
  it('includes LinkedIn/company redirects in the external queue, keeping unsupported portals manual in the engine', () => {
    const { runner } = setup('external', [job('linked', 'external', { source: 'LINKEDIN', url: 'https://www.linkedin.com/jobs/view/123456' }), job('board', 'hirist'), job('company', 'hirist', { flags: ['apply:company-site'] })]);
    expect(runner.preview().jobs.map((j) => j.id).sort()).toEqual(['company', 'linked']);
  });
  it('uses independent mode switches and a shared PDF/settings store', () => {
    const { runner } = setup('external'); runner.settings('on', { minScore: 75, max: 2, days: 14 });
    expect(loadSettings(process.env.JOB_HUNTER_SETTINGS)).toMatchObject({ autoApply: { naukri: 'on', hirist: 'on', instahyre: 'on', external: 'on' }, minScore: 75 });
  });
  it('deduplicates company/title and destination aliases across boards', () => {
    const { runner, logFile } = setup('external', [job('direct', 'external', { company: 'Acme', url: 'https://job-boards.greenhouse.io/acme/jobs/123456' }), job('same-company', 'external', { company: 'Earlier company' })]);
    record({ jobId: 'linked', company: 'Earlier company', title: 'Senior Backend Engineer', url: 'https://www.linkedin.com/jobs/view/998877', targetUrl: 'https://boards.greenhouse.io/embed/job_app?for=123456&token=acme', platform: 'external', at: now.toISOString(), status: 'applied' }, logFile);
    expect(runner.preview().jobs).toHaveLength(0);
  });
  it('discovers each board independently and keeps checks non-submitting', async () => {
    const { runner, apply, logFile } = setup('instahyre'); runner.find(7); await runner.settled(); expect(apply).not.toHaveBeenCalled();
    const p = runner.preview(); runner.start('dry-run', p.token, p.options); await runner.settled(); expect(loadLog(logFile).a.status).toBe('dry-run');
  });
  it('shares the daily quota across all panels', () => {
    const { runner, logFile } = setup('hirist');
    for (let i = 0; i < 30; i++) record({ jobId: `done-${i}`, title: 'Other', company: String(i), url: `https://jobs.ashbyhq.com/acme/${i}`, platform: 'external', status: i ? 'applied' : 'verification-required', at: now.toISOString() }, logFile);
    expect(runner.preview()).toMatchObject({ remainingToday: 0, jobs: [] });
  });
  it('exposes platform routes and rejects cross-site mutations and competing Chrome runs', async () => {
    const hirist = setup('hirist'); const instahyre = setup('instahyre'); const external = setup('external'); const naukri = setup('naukri');
    const service = createServer({ naukri: naukri.runner, platforms: { hirist: hirist.runner, instahyre: instahyre.runner, external: external.runner }, load: hirist.load, applicationLog: () => loadLog(hirist.logFile) });
    await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
    try {
      for (const name of ['hirist', 'instahyre', 'external']) expect((await fetch(`${base}/api/${name}/preview`)).status).toBe(200);
      const p = hirist.runner.preview();
      const crossSite = await fetch(`${base}/api/hirist/start`, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ ...p.options, mode: 'apply', token: p.token }) }); expect(crossSite.status).toBe(403);
      const stale = await fetch(`${base}/api/hirist/start`, { method: 'POST', body: JSON.stringify({ ...p.options, mode: 'apply', token: 'stale' }) }); expect(stale.status).toBe(409);
      const originalStatus = hirist.runner.status;
      hirist.runner.status = () => ({ ...originalStatus(), running: true });
      const ip = instahyre.runner.preview();
      expect((await fetch(`${base}/api/instahyre/start`, { method: 'POST', body: JSON.stringify({ ...ip.options, mode: 'apply', token: ip.token }) })).status).toBe(409);
      expect((await fetch(`${base}/api/application/login?site=naukri`, { method: 'POST', body: '{}' })).status).toBe(409);
      expect((await fetch(`${base}/api/discover`, { method: 'POST' })).status).toBe(409);
      expect((await fetch(`${base}/api/external/resume`, { method: 'POST', body: JSON.stringify({ base64: Buffer.from('%PDF-1.4').toString('base64') }) })).status).toBe(409);
      hirist.runner.status = originalStatus;
      expect((await fetch(`${base}/api/hirist/start`, { method: 'POST', body: JSON.stringify({ ...p.options, mode: 'apply', token: p.token }) })).status).toBe(202);
      await hirist.runner.settled(); expect(hirist.apply).toHaveBeenCalledTimes(1);
    } finally { service.closeAllConnections(); await new Promise<void>((resolve) => service.close(() => resolve())); }
  });
});
