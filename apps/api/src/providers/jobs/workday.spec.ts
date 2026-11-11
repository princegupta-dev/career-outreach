import { criteriaFor, loadProfile } from '../../search';
import { httpRetry } from '../http';
import type { SearchStats } from './job-provider.interface';
import { WorkdayProvider } from './workday';

const config = { companyName: 'PayPal', workday: { host: 'https://paypal.wd1.myworkdayjobs.com', tenant: 'paypal', site: 'jobs' } };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const urlOf = (i: string | URL | Request) => (typeof i === 'string' ? i : i instanceof URL ? i.toString() : i.url);

describe('WorkdayProvider', () => {
  const criteria = criteriaFor(loadProfile(), 30);
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  beforeEach(() => {
    calls.length = 0;
    httpRetry.baseDelayMs = 1;
  });
  afterEach(() => {
    jest.restoreAllMocks();
    httpRetry.baseDelayMs = 700;
  });

  it('lists with the public search endpoint, fetches details, and builds a full posting', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (i, init) => {
      const url = urlOf(i);
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
      if (url.endsWith('/wday/cxs/paypal/jobs/jobs')) {
        return json({ jobPostings: [
          { title: 'Sr Software Engineer, Back End', externalPath: '/job/Bangalore/Sr-SE_R1', locationsText: '2 Locations', postedOn: 'Posted 5 Days Ago' },
          { title: 'Sales Director', externalPath: '/job/Bangalore/Sales_R2', locationsText: 'Bangalore', postedOn: 'Posted Today' },
          { title: 'Backend Engineer', externalPath: '/job/Austin/BE_R3', locationsText: 'Austin', postedOn: 'Posted 30+ Days Ago' },
        ] });
      }
      if (url.endsWith('/job/Bangalore/Sr-SE_R1')) {
        return json({ jobPostingInfo: { title: 'Sr Software Engineer, Back End', jobReqId: 'R1', location: 'Bangalore, Karnataka, India', additionalLocations: ['Chennai, India'], jobDescription: '<p>Node.js and PostgreSQL services.</p>', externalUrl: 'https://paypal.wd1.myworkdayjobs.com/jobs/job/R1', timeType: 'Full time' } });
      }
      return json({ jobPostingInfo: { title: 'Backend Engineer', location: 'Austin, TX', jobDescription: '<p>x</p>' } });
    });
    const out = await new WorkdayProvider().searchJobs(criteria, config);
    // One POST per keyword search; the same job found by several searches is fetched once.
    expect(calls.filter((c) => c.method === 'POST').map((c) => JSON.parse(c.body!).searchText)).toEqual(['backend', 'software engineer', 'node.js']);
    expect(calls.filter((c) => c.method === 'GET').map((c) => c.url)).not.toContain('https://paypal.wd1.myworkdayjobs.com/wday/cxs/paypal/jobs/job/Bangalore/Sales_R2');
    const se = out.find((j) => j.externalId === 'R1')!;
    expect(se).toMatchObject({ provider: 'WORKDAY', companyName: 'PayPal', title: 'Sr Software Engineer, Back End', location: 'Bangalore, Karnataka, India; Chennai, India', url: 'https://paypal.wd1.myworkdayjobs.com/jobs/job/R1', employmentType: 'Full time' });
    expect(se.description).toBe('Node.js and PostgreSQL services.');
    expect(se.postedAt).toBeInstanceOf(Date);
  });

  it('reports failed details instead of hiding them', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (i) =>
      urlOf(i).endsWith('/jobs') ? json({ jobPostings: [{ title: 'Backend Engineer', externalPath: '/job/x/BE_1', locationsText: 'Pune, India', postedOn: 'Posted Today' }] }) : json({}, 500),
    );
    const stats: SearchStats = { fetched: 0 };
    expect(await new WorkdayProvider().searchJobs({ ...criteria, stats }, config)).toEqual([]);
    expect(stats.warnings).toEqual([expect.stringMatching(/PayPal \(Workday\): 1 of 1 job details failed/)]);
  });

  it('refuses a source without host, tenant and site', async () => {
    await expect(new WorkdayProvider().searchJobs(criteria, { companyName: 'X' })).rejects.toThrow(/host, tenant and site/);
  });
});
