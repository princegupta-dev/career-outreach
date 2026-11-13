import { AddressInfo } from 'net';
import { BACKEND_JD, JAVA_JD, loadProfile } from './domain/__fixtures__/fixtures';
import { createServer } from './main';
import type { ProviderJob } from './providers/jobs/job-provider.interface';
import { criteriaFor, dedupeJobs, FoundJob, toFoundJob } from './search';

const profile = loadProfile();
const criteria = criteriaFor(profile);
const now = new Date('2026-10-06T00:00:00Z');
const posting = (over: Partial<ProviderJob> = {}): ProviderJob => ({
  provider: 'GREENHOUSE', externalId: '1', url: 'https://boards.greenhouse.io/acme/jobs/1', title: 'Senior Backend Engineer',
  companyName: 'Acme', location: 'Bengaluru, India', remote: false, description: BACKEND_JD, postedAt: new Date('2026-10-01'), ...over,
});

describe('toFoundJob', () => {
  it('scores a matching backend job above a Java one', () => {
    const node = toFoundJob(posting(), criteria, profile, now)!;
    const java = toFoundJob(posting({ externalId: '2', url: 'https://boards.greenhouse.io/acme/jobs/2', description: JAVA_JD }), criteria, profile, now)!;
    expect(node.score).toBeGreaterThan(java.score);
    expect(node.postedAt).toBe('2026-10-01T00:00:00.000Z');
  });

  it('gives the same id on every run, so the browser can hide jobs already seen', () => {
    expect(toFoundJob(posting(), criteria, profile, now)!.id).toBe(toFoundJob(posting(), criteria, profile, now)!.id);
  });

  it('drops postings without a real description', () => {
    expect(toFoundJob(posting({ description: 'Apply now' }), criteria, profile, now)).toBeNull();
  });

  it('passes through only contacts published in the posting', () => {
    const c = { name: 'Jane', roleCategory: 'RECRUITER' as const, email: 'jane@acme.com', source: 'posting', confidence: 'VERIFIED' as const };
    expect(toFoundJob(posting({ contacts: [c] }), criteria, profile, now)!.contacts).toEqual([c]);
    expect(toFoundJob(posting(), criteria, profile, now)!.contacts).toEqual([]);
  });
});

describe('dedupeJobs', () => {
  const j = (over: Partial<FoundJob>): FoundJob => ({ ...toFoundJob(posting(), criteria, profile, now)!, ...over });
  it('keeps one copy of the same job from two sources, the higher-scored one', () => {
    const out = dedupeJobs([j({ id: 'a', score: 60 }), j({ id: 'b', score: 70, company: 'ACME' })]);
    expect(out.map((x) => x.id)).toEqual(['b']);
  });
  it('keeps different roles at the same company', () => {
    expect(dedupeJobs([j({ id: 'a' }), j({ id: 'b', title: 'Platform Engineer' })])).toHaveLength(2);
  });
});

describe('HTTP API', () => {
  it('runs a search, saves it to the shared file, and serves every saved job at /api/jobs', async () => {
    const calls: unknown[] = [];
    const run = { ranAt: '2026-11-11T00:00:00.000Z', jobs: [toFoundJob(posting(), criteria, profile, now)!], sources: [], warnings: [] };
    let store = { updatedAt: null as string | null, jobs: {} as Record<string, unknown> };
    const server = createServer({
      search: async (o) => (calls.push(o), run),
      save: (r) => (store = { updatedAt: r.ranAt, jobs: Object.fromEntries(r.jobs.map((j) => [j.id, { ...j, firstSeenAt: r.ranAt, lastSeenAt: r.ranAt }])) }) as never,
      load: () => store as never,
      history: () => ({ jobs: { [run.jobs[0].id]: { key: 'k', shownOn: '2026-11-12', source: 'GREENHOUSE', title: 't', company: 'c', score: 80 } } }),
      insights: () => ({ jobsAnalysed: 1 }) as never,
    }).listen(0);
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address() as AddressInfo;
    try {
      expect(await (await fetch(`http://127.0.0.1:${port}/api/jobs`)).json()).toEqual({ updatedAt: null, jobs: [] });
      const ok = await fetch(`http://127.0.0.1:${port}/api/jobs/search?days=7`);
      expect(ok.status).toBe(200);
      expect(calls).toEqual([{ maxAgeDays: 7, startups: { minTeam: 50, maxTeam: 100 } }]);
      const all = (await (await fetch(`http://127.0.0.1:${port}/api/jobs`)).json()) as { updatedAt: string; jobs: Array<{ id: string; firstSeenAt: string }> };
      expect(all.updatedAt).toBe('2026-11-11T00:00:00.000Z');
      expect(all.jobs.map((j) => j.id)).toEqual([run.jobs[0].id]);
      expect((all.jobs[0] as unknown as { shownOn: string }).shownOn).toBe('2026-11-12');
      expect(await (await fetch(`http://127.0.0.1:${port}/api/insights`)).json()).toEqual({ jobsAnalysed: 1 });
      expect(await (await fetch(`http://127.0.0.1:${port}/api/stats`)).json()).toEqual([{ day: '2026-11-12', total: 1, bySource: { GREENHOUSE: 1 }, avgScore: 80 }]);
      expect((await fetch(`http://127.0.0.1:${port}/api/nope`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe('age window (you asked for the latest jobs)', () => {
  it('still keeps the backend roles you want', async () => {
    const { passesBasicFilters } = await import('./providers/jobs/job-provider.interface');
    for (const title of ['Senior Backend Engineer, Cloud Cost & Capacity', 'Platform Engineer, Edge & Networking', 'Node Js Developer', 'Senior Full-Stack Engineer (backend-heavy)', 'Software Development Engineer 3']) {
      expect([title, passesBasicFilters(posting({ title }), criteria, now)]).toEqual([title, true]);
    }
  });

  it('drops company-board postings first published before the window, keeps undated ones', async () => {
    const { passesBasicFilters } = await import('./providers/jobs/job-provider.interface');
    const week = criteriaFor(profile, 7);
    expect(passesBasicFilters(posting({ postedAt: new Date('2026-03-01') }), week, now)).toBe(false);
    expect(passesBasicFilters(posting({ postedAt: new Date('2026-10-03') }), week, now)).toBe(true);
    expect(passesBasicFilters(posting({ postedAt: null }), week, now)).toBe(true);
  });

  it('rejects titles that are not backend roles', async () => {
    const { passesBasicFilters } = await import('./providers/jobs/job-provider.interface');
    for (const title of ['Customer Experience Engineer, L1', 'Software Engineer Interviewer', 'Senior Software Engineer (NetSuite Developer)', 'Senior Security Engineer', 'Lead, Technical Services Engineer', 'New grads who shipped AI features', 'Quality Assurance Automation Engineer - Playwright/Appium',
      'Senior DevOps Engineer', 'Senior Staff Site Reliability Engineer', 'Tier III Service Desk Engineer', 'Solution Engineer', 'Principal Enterprise Architect',
      'Senior C++ Software Engineer', 'AWS RUST Developer (P0)', 'Data Engineer', 'Senior Engineer I, Field service']) {
      expect(passesBasicFilters(posting({ title }), criteria, now)).toBe(false);
    }
  });
});
