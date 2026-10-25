import type { INestApplicationContext } from '@nestjs/common';
import { PrismaService } from '../../src/common/prisma.service';
import { RedisService } from '../../src/common/redis.service';
import { DirectoryService, YC_DATASET_URL } from '../../src/modules/discovery/directory.service';
import { DiscoveryService } from '../../src/modules/discovery/discovery.service';
import { JobsService } from '../../src/modules/jobs/jobs.service';
import { httpRetry } from '../../src/providers/http';
import { createContext, createUser, flushRedis, resetDatabase } from '../setup/helpers';
import { installMockWeb } from '../setup/mock-web';

const JD = '<p>Backend role.</p><ul><li>3+ years building backend systems</li><li>Node.js and TypeScript</li><li>PostgreSQL, Redis and AWS</li></ul>';
const enc = (s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const fresh = () => new Date().toISOString();

const YC = [
  { id: 1, slug: 'acme-robotics', name: 'Acme Robotics', website: 'https://acmerobotics.com', team_size: 120, all_locations: 'San Francisco, CA, USA', industry: 'Industrials', subindustry: 'Robotics', industries: ['Industrials'], batch: 'W21', isHiring: true },
  { id: 2, slug: 'linear-labs', name: 'Linear Labs', website: 'https://linearlabs.io', team_size: 60, all_locations: 'Bengaluru, India', industry: 'B2B', isHiring: true },
  { id: 3, slug: 'flaky', name: 'Flaky Co', website: 'https://flaky.dev', team_size: 40, isHiring: true },
  { id: 4, slug: 'ghost', name: 'Ghost Inc', website: 'https://ghost.example', team_size: 30, isHiring: true },
  { id: 5, slug: 'not-hiring', name: 'Not Hiring', website: 'https://nothiring.com', team_size: 50, isHiring: false },
  { id: 6, slug: 'charity', name: 'Charity', website: 'https://charity.org', team_size: 50, isHiring: true, nonprofit: true },
  { id: 7, slug: 'giant', name: 'Giant Corp', website: 'https://giant.com', team_size: 5000, isHiring: true },
];

describe('Startup directory → job boards → jobs (integration, mocked internet)', () => {
  let ctx: INestApplicationContext;
  let prisma: PrismaService;
  let directory: DirectoryService;
  let jobs: JobsService;
  let userId: string;
  let urls: string[];

  beforeAll(async () => {
    ctx = await createContext();
    prisma = ctx.get(PrismaService);
    directory = ctx.get(DirectoryService);
    jobs = ctx.get(JobsService);
    httpRetry.baseDelayMs = 1;
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    await prisma.directoryCompany.deleteMany();
    await flushRedis();
    userId = (await createUser(prisma)).id;
    urls = [];
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    httpRetry.baseDelayMs = 700;
    await ctx.close();
  });

  const gh = (id: number, title: string, location: string) => ({ id, title, absolute_url: `https://boards.greenhouse.io/acmerobotics/jobs/${id}`, location: { name: location }, first_published: fresh() });
  const ACME_ROLES = [gh(1, 'Senior Backend Engineer', 'Bengaluru, India'), gh(2, 'Staff Software Engineer, Platform', 'Remote'), gh(3, 'Backend Engineer', 'Denver, Colorado'), gh(4, 'Account Executive', 'Remote')];
  const mockWeb = () =>
    jest.spyOn(global, 'fetch').mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      urls.push(url);
      if (url === YC_DATASET_URL) return json(YC);
      // Acme Robotics: a real Greenhouse board whose name matches.
      if (url.endsWith('/boards/acmerobotics')) return json({ name: 'Acme Robotics Inc' });
      if (url.endsWith('/boards/acmerobotics/jobs')) return json({ jobs: ACME_ROLES });
      const detail = /acmerobotics\/jobs\/(\d+)$/.exec(url);
      if (detail) return json({ ...ACME_ROLES.find((j) => j.id === Number(detail[1])), content: enc(`${JD}<p>role ${detail[1]}</p>`) });
      // Linear Labs: the slug "linearlabs" exists on Ashby but belongs to someone else.
      if (url.endsWith('/job-board/linearlabs')) return json({ jobs: [{ id: 'x1', title: 'Engineer', descriptionPlain: 'Join Totally Different Corp and build things.' }] });
      // Flaky Co: the Greenhouse API is down.
      if (/boards\/flaky/.test(url)) return json({}, 503);
      if (/\/job-board\/flaky|postings\/flaky/.test(url)) return json({}, 404);
      return json({}, 404); // everything else: no such board
    });

  it('syncs hiring startups with size, location, category and provenance (and skips non-hiring, nonprofit and huge companies)', async () => {
    mockWeb();
    expect(await directory.sync()).toBe(4);
    const rows = await prisma.directoryCompany.findMany({ orderBy: { name: 'asc' } });
    expect(rows.map((r) => r.name)).toEqual(['Acme Robotics', 'Flaky Co', 'Ghost Inc', 'Linear Labs']);
    const acme = rows.find((r) => r.name === 'Acme Robotics')!;
    expect(acme).toMatchObject({ teamSize: 120, domain: 'acmerobotics.com', category: 'Industrials / Robotics', status: 'PENDING', location: 'San Francisco, CA, USA' });
    expect(acme.provenance).toMatchObject({ source: 'yc-oss', url: YC_DATASET_URL, ycSlug: 'acme-robotics', batch: 'W21' });
  });

  it('syncs at most once a day, and repeated syncs never duplicate companies', async () => {
    mockWeb();
    await directory.sync();
    expect(await directory.sync()).toBe(0);
    expect(urls.filter((u) => u === YC_DATASET_URL)).toHaveLength(1);
    await directory.sync(true);
    expect(await prisma.directoryCompany.count()).toBe(4);
  });

  it('probes public boards, verifies the board really belongs to the company, and retries network failures instead of recording "no board"', async () => {
    mockWeb();
    await directory.sync();
    const r = await directory.probe(10);
    expect(r).toMatchObject({ probed: 4, withBoard: 1, unverified: 1 });
    expect(r.warnings).toEqual([expect.stringMatching(/1 of 4 companies could not be probed/)]);

    const by = Object.fromEntries((await prisma.directoryCompany.findMany()).map((c) => [c.name, c]));
    expect(by['Acme Robotics']).toMatchObject({ status: 'HAS_BOARD', ats: 'GREENHOUSE', atsSlug: 'acmerobotics', careerUrl: 'https://boards.greenhouse.io/acmerobotics' });
    expect(by['Acme Robotics'].provenance).toMatchObject({ board: { ats: 'GREENHOUSE', jobs: 4, verified: 'board-name' } });
    // Slug collision: a board exists but is not theirs → not used, and the reason is recorded.
    expect(by['Linear Labs'].status).toBe('NO_BOARD');
    expect((by['Linear Labs'].provenance as { board: { rejected: string } }).board.rejected).toBe('ASHBY/linearlabs exists but does not mention "Linear Labs"');
    expect(by['Ghost Inc'].status).toBe('NO_BOARD');
    // Upstream error: stays PENDING so the next run tries again.
    expect(by['Flaky Co']).toMatchObject({ status: 'PENDING' });
    expect(by['Flaky Co'].probedAt).not.toBeNull();
  });

  it('turns verified boards into job sources with provenance, once, without duplicating boards already watched', async () => {
    mockWeb();
    await directory.sync();
    await directory.probe(10);
    // The user already watches this very board under another name.
    await prisma.jobSource.create({ data: { userId, provider: 'GREENHOUSE', name: 'Acme (manual)', config: { boardToken: 'AcmeRobotics' } } });
    expect(await directory.promote(userId)).toBe(0);
    await prisma.jobSource.deleteMany();

    expect(await directory.promote(userId)).toBe(1);
    expect(await directory.promote(userId)).toBe(0); // idempotent
    const src = await prisma.jobSource.findFirstOrThrow({ where: { userId } });
    expect(src).toMatchObject({ provider: 'GREENHOUSE', name: 'Acme Robotics', isDefault: false });
    expect(src.config).toMatchObject({ boardToken: 'acmerobotics', teamSize: 120, category: 'Industrials / Robotics', careerUrl: 'https://boards.greenhouse.io/acmerobotics', provenance: { source: 'yc-oss' } });
  });

  it('end to end: a discovered startup yields flagged jobs and a company with size, category, career URL and provenance', async () => {
    mockWeb();
    await directory.refresh(userId);
    const src = await prisma.jobSource.findFirstOrThrow({ where: { userId, name: 'Acme Robotics' } });
    const r = await jobs.runSource(userId, src.id);

    // India role + a "Remote" role with no stated region are kept; the Colorado role and the sales role are rejected for stated reasons.
    expect(r).toMatchObject({ fetched: 4, created: 2, uncertain: 1 });
    expect(r.rejected).toEqual({ 'region:onsite-outside-targets': 1, 'title:not-engineering': 1 });

    const stored = await prisma.job.findMany({ orderBy: { title: 'asc' }, include: { company: true } });
    const india = stored.find((j) => j.title === 'Senior Backend Engineer')!;
    expect(india).toMatchObject({ eligibility: 'ELIGIBLE' });
    const staff = stored.find((j) => j.title.startsWith('Staff'))!;
    expect(staff.eligibility).toBe('UNCERTAIN');
    expect(staff.eligibilityFlags).toEqual(expect.arrayContaining(['seniority:staff', 'location:remote-region-unstated']));

    const company = india.company;
    expect(company).toMatchObject({ teamSize: 120, size: 'GROWTH_STARTUP', category: 'Industrials / Robotics', careerUrl: 'https://boards.greenhouse.io/acmerobotics' });
    expect(company.provenance).toMatchObject({ source: 'yc-oss' });
  });

  describe('source health', () => {
    it('counts consecutive failures, and resets them (recording the last success) when the source works again', async () => {
      const s = await prisma.jobSource.create({ data: { userId, provider: 'GREENHOUSE', name: 'Acme Robotics', config: { boardToken: 'acmerobotics', companyName: 'Acme Robotics' } } });
      jest.spyOn(global, 'fetch').mockImplementation(async () => json({}, 503));
      await expect(jobs.runSource(userId, s.id)).rejects.toThrow();
      await expect(jobs.runSource(userId, s.id)).rejects.toThrow();
      expect(await prisma.jobSource.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ consecutiveFailures: 2, lastSuccessAt: null });

      jest.restoreAllMocks();
      mockWeb();
      await jobs.runSource(userId, s.id);
      const healed = await prisma.jobSource.findUniqueOrThrow({ where: { id: s.id } });
      expect(healed.consecutiveFailures).toBe(0);
      expect(healed.lastSuccessAt).not.toBeNull();
      expect(healed.lastError).toBeNull();
    });

    it('a full run skips a source that keeps failing (retrying it daily), says so, and reports the directory', async () => {
      const web = installMockWeb();
      try {
        await jobs.ensureDefaultSources(userId);
        const broken = await prisma.jobSource.findFirstOrThrow({ where: { userId, provider: 'REMOTIVE' } });
        await prisma.jobSource.update({ where: { id: broken.id }, data: { consecutiveFailures: 6, lastRunAt: new Date() } });
        const stale = await prisma.jobSource.findFirstOrThrow({ where: { userId, provider: 'JOBICY' } });
        await prisma.jobSource.update({ where: { id: stale.id }, data: { consecutiveFailures: 6, lastRunAt: new Date(Date.now() - 2 * 86_400_000) } });

        const run = await ctx.get(DiscoveryService).runAll(userId, 'manual');
        expect(run.sourcesSkipped).toBe(1);
        expect(run.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'Source health' })]));
        expect(run.directory).toMatchObject({ synced: 0, probed: 0, sourcesAdded: 0 });
        expect((await prisma.jobSource.findUniqueOrThrow({ where: { id: broken.id } })).consecutiveFailures).toBe(6); // not run
        expect((await prisma.jobSource.findUniqueOrThrow({ where: { id: stale.id } })).consecutiveFailures).toBe(7); // retried, failed again
      } finally {
        web.restore();
      }
    });

    it('a directory outage never blocks the sources we already have', async () => {
      const web = installMockWeb();
      const real = global.fetch as jest.Mock;
      const impl = real.getMockImplementation()!;
      real.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url === YC_DATASET_URL) return json({}, 500);
        return impl(input, init);
      });
      try {
        const run = await ctx.get(DiscoveryService).runAll(userId, 'manual');
        expect(run.created).toBeGreaterThan(0);
        expect(run.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'Startup directory', warning: expect.stringMatching(/directory sync failed/i) })]));
        await ctx.get(RedisService).client.del('directory:synced:yc-oss');
      } finally {
        web.restore();
      }
    });
  });
});
