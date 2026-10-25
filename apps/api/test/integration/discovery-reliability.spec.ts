import type { INestApplicationContext } from '@nestjs/common';
import { PrismaService } from '../../src/common/prisma.service';
import { JobsService } from '../../src/modules/jobs/jobs.service';
import { createContext, createUser, flushRedis, resetDatabase } from '../setup/helpers';

/**
 * Discovery reliability (mocked internet, test database): what happens to jobs after they are listed —
 * persistence, idempotency, bad upstream data, and whether problems are visible in the run stats.
 */
const JD = '<p>Backend role.</p><ul><li>3+ years building backend systems</li><li>Node.js and TypeScript</li><li>PostgreSQL, Redis and AWS</li></ul>';
const enc = (s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const fresh = () => new Date().toISOString();

interface GhFixture {
  id: number;
  title?: string;
  location?: string;
  first_published?: string;
  content?: string;
}

describe('Discovery reliability (integration, mocked internet)', () => {
  let ctx: INestApplicationContext;
  let prisma: PrismaService;
  let jobs: JobsService;
  let userId: string;

  beforeAll(async () => {
    ctx = await createContext();
    prisma = ctx.get(PrismaService);
    jobs = ctx.get(JobsService);
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    await flushRedis();
    userId = (await createUser(prisma)).id;
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => ctx.close());

  const board = async (fixtures: GhFixture[]) => {
    const listing = fixtures.map((f) => ({
      id: f.id,
      title: f.title ?? 'Senior Backend Engineer',
      absolute_url: `https://boards.greenhouse.io/probeco/jobs/${f.id}`,
      location: { name: f.location ?? 'Bengaluru, India' },
      first_published: f.first_published ?? fresh(),
    }));
    jest.spyOn(global, 'fetch').mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/boards/probeco')) return json({ name: 'ProbeCo' });
      if (url.endsWith('/boards/probeco/jobs')) return json({ jobs: listing });
      const id = Number(/jobs\/(\d+)$/.exec(url)?.[1]);
      const f = fixtures.find((x) => x.id === id);
      if (!f) throw new Error(`unexpected fetch ${url}`);
      return json({ ...listing.find((l) => l.id === id), content: f.content ?? enc(`${JD}<p>posting ${id}</p>`) });
    });
    return prisma.jobSource.create({ data: { userId, provider: 'GREENHOUSE', name: 'ProbeCo', config: { boardToken: 'probeco', companyName: 'ProbeCo', domain: 'probeco.com' } } });
  };

  it('is idempotent: running the same source repeatedly never creates a second record', async () => {
    const s = await board([{ id: 1 }, { id: 2 }]);
    const first = await jobs.runSource(userId, s.id);
    const second = await jobs.runSource(userId, s.id);
    const third = await jobs.runSource(userId, s.id);
    expect(first).toMatchObject({ fetched: 2, created: 2, duplicates: 0 });
    expect(second).toMatchObject({ created: 0, duplicates: 2 });
    expect(third).toMatchObject({ created: 0, duplicates: 2 });
    expect(await prisma.job.count()).toBe(2);
    expect(await prisma.application.count()).toBe(2);
    expect(await prisma.company.count()).toBe(1);
  });

  it('does not bring back a job the user deleted (a manual re-import still does)', async () => {
    const s = await board([{ id: 1 }]);
    await jobs.runSource(userId, s.id);
    const created = await prisma.job.findFirstOrThrow();
    await jobs.remove(userId, created.id);

    const rerun = await jobs.runSource(userId, s.id);
    expect(rerun).toMatchObject({ created: 0, duplicates: 1 });
    expect((await prisma.job.findUniqueOrThrow({ where: { id: created.id } })).deletedAt).not.toBeNull();
    expect((await jobs.list(userId, {})).total).toBe(0);
    expect(await prisma.job.count()).toBe(1); // still no duplicate row

    const manual = await jobs.createManual(userId, { title: created.title, companyName: 'ProbeCo', description: created.description });
    expect(manual).toMatchObject({ jobId: created.id, duplicate: true });
    expect((await jobs.list(userId, {})).total).toBe(1);
  });

  it('a malformed upstream date no longer loses the job (stored as "unknown date")', async () => {
    const s = await board([{ id: 1, first_published: 'garbage' }, { id: 2 }]);
    const r = await jobs.runSource(userId, s.id);
    expect(r).toMatchObject({ fetched: 2, afterBasicFilters: 2, created: 2, failed: 0 });
    const bad = await prisma.job.findFirstOrThrow({ where: { externalId: 'probeco:1' } });
    expect(bad.postedAt).toBeNull();
  });

  it('shows why postings were dropped, per reason, in the run stats', async () => {
    const s = await board([
      { id: 1 },
      { id: 2, title: 'Frontend Software Engineer' },
      { id: 3, title: 'Product Designer' },
      { id: 4, location: 'San Francisco, CA' },
      { id: 5, location: 'Remote - USA' },
      { id: 6, first_published: new Date(Date.now() - 90 * 86_400_000).toISOString() },
    ]);
    const r = await jobs.runSource(userId, s.id);
    // id 6 is 90 days old but still on the company's board, so it is open: kept and flagged, not dropped.
    expect(r).toMatchObject({ fetched: 6, afterBasicFilters: 2, created: 2 });
    expect(r.rejected).toEqual({ 'title:excluded': 1, 'title:not-engineering': 1, 'region:onsite-outside-targets': 1, 'region:remote-not-india-compatible': 1 });
    const old = await prisma.job.findFirstOrThrow({ where: { externalId: 'probeco:6' } });
    expect(old.eligibility).toBe('ELIGIBLE');
    expect(old.eligibilityFlags).toContain('age:older-than-30d');
    const stored = await prisma.jobSource.findUniqueOrThrow({ where: { id: s.id } });
    expect(stored.lastStats).toMatchObject({ rejected: r.rejected });
  });

  it('counts unusable postings and save failures instead of dropping them silently', async () => {
    const s = await board([{ id: 1, content: enc('<p>Too short</p>') }, { id: 2 }, { id: 3 }]);
    const original = jobs.ingest.bind(jobs);
    jest.spyOn(jobs, 'ingest').mockImplementation(async (u, pj, sid, o) => {
      if (pj.externalId === 'probeco:3') throw new Error('connection reset by peer');
      return original(u, pj, sid, o);
    });
    const r = await jobs.runSource(userId, s.id);
    expect(r).toMatchObject({ fetched: 3, afterBasicFilters: 3, invalid: 1, failed: 1, created: 1 });
    expect(r.failures).toEqual([expect.stringMatching(/Senior Backend Engineer: connection reset by peer/)]);
    const stored = await prisma.jobSource.findUniqueOrThrow({ where: { id: s.id } });
    expect(stored.lastStats).toMatchObject({ invalid: 1, failed: 1 });
  });

  it('reports job details that could not be read, and still keeps the rest', async () => {
    const s = await board([{ id: 1 }, { id: 2 }]);
    const impl = (global.fetch as jest.Mock).getMockImplementation()!;
    jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return url.endsWith('/jobs/2') ? json({}, 404) : impl(input, init);
    });
    const r = await jobs.runSource(userId, s.id);
    expect(r.created).toBe(1);
    expect(r.warnings).toEqual([expect.stringMatching(/probeco: 1 of 2 job details failed to load or were empty/)]);
  });

  it('a source that is down is recorded as an error with its message (and retried first)', async () => {
    const s = await board([{ id: 1 }]);
    const calls: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (input: string | URL | Request) => {
      calls.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      return json({}, 503);
    });
    const { httpRetry } = await import('../../src/providers/http');
    httpRetry.baseDelayMs = 1;
    try {
      await expect(jobs.runSource(userId, s.id)).rejects.toThrow(/HTTP 503/);
    } finally {
      httpRetry.baseDelayMs = 700;
    }
    expect(calls.filter((c) => c.endsWith('/boards/probeco/jobs'))).toHaveLength(3); // 1 try + 2 retries
    expect((await prisma.jobSource.findUniqueOrThrow({ where: { id: s.id } })).lastError).toMatch(/HTTP 503/);
    expect(await prisma.job.count()).toBe(0);
  });
});
