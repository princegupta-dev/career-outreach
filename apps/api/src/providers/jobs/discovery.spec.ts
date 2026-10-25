import { cumulativeDays, relativeDays, resolveSettings } from '../../domain/settings';
import { FetchError, httpFetch, httpRetry } from '../http';
import { extractEmails, HimalayasProvider, parseArbeitnow, parseHimalayas, parseHnComment, parseJobicy, parseRemoteOk, parseRemotive, parseWwrRss, WeWorkRemotelyProvider } from './aggregators';
import { AshbyProvider, GreenhouseProvider, LeverProvider } from './ats.providers';
import { DEFAULT_EXCLUDE_TITLES, DEFAULT_SOURCES, FLAG_TITLES } from './default-sources';
import { assessEligibility, basicFilterReason, classifyLocation, classifyPosting, filterListed, JobSearchCriteria, parseDate, passesBasicFilters, remoteRegionOk, titleHas } from './job-provider.interface';

const criteria = {
  titleKeywords: ['backend', 'software engineer', 'node'],
  excludeTitleKeywords: ['frontend', 'manager', 'rust'],
  locations: ['India', 'Bengaluru', 'Gurugram'],
  includeRemote: true,
  postedWithinDays: 30,
};
const now = new Date('2026-10-06T00:00:00Z');

describe('basic discovery filters', () => {
  it('keeps remote roles open to India/worldwide and drops region-locked ones', () => {
    expect(remoteRegionOk('Remote')).toBe(true);
    expect(remoteRegionOk('Remote (Worldwide)')).toBe(true);
    expect(remoteRegionOk('Remote - APAC')).toBe(true);
    expect(remoteRegionOk('Remote, India')).toBe(true);
    expect(remoteRegionOk('Remote (USA Only)')).toBe(false);
    expect(remoteRegionOk('Remote - Europe')).toBe(false);
    expect(remoteRegionOk('Remote (US/Canada)')).toBe(false);
  });

  it('applies title, region and age filters together', () => {
    const base = { title: 'Senior Backend Engineer', location: 'Remote (Worldwide)', remote: true, postedAt: new Date('2026-10-01') };
    expect(passesBasicFilters(base, criteria, now)).toBe(true);
    expect(passesBasicFilters({ ...base, title: 'Senior Frontend Engineer' }, criteria, now)).toBe(false);
    expect(passesBasicFilters({ ...base, title: 'Engineering Manager, Backend' }, criteria, now)).toBe(false);
    expect(passesBasicFilters({ ...base, title: 'Backend Engineer, Trust & Safety' }, criteria, now)).toBe(true); // "rust" ≠ "trust"
    expect(passesBasicFilters({ ...base, location: 'Remote (US only)' }, criteria, now)).toBe(false);
    expect(passesBasicFilters({ ...base, location: 'Bengaluru, India', remote: false }, criteria, now)).toBe(true);
    expect(passesBasicFilters({ ...base, location: 'Berlin, Germany', remote: false }, criteria, now)).toBe(false);
    expect(passesBasicFilters({ ...base, location: 'Berlin, Germany', remote: false }, { ...criteria, allowRelocation: true }, now)).toBe(true);
    expect(passesBasicFilters({ ...base, postedAt: new Date('2026-08-01') }, criteria, now)).toBe(false);
  });

  it('hard-rejects new-grad, junior, intern and management titles; staff/principal are flagged for ranking, not rejected', () => {
    const c = { ...criteria, excludeTitleKeywords: DEFAULT_EXCLUDE_TITLES, flagTitleKeywords: FLAG_TITLES };
    const base = { title: 'Senior Backend Engineer', location: 'Remote (Worldwide)', remote: true, postedAt: new Date('2026-10-01') };
    expect(passesBasicFilters(base, c, now)).toBe(true);
    for (const title of [
      'Software Engineer, New Grad (2027)',
      'New-Grad Backend Engineer',
      'Junior Backend Developer',
      'Jr. Node.js Engineer',
      'Entry-Level Software Engineer',
      'Early-Career Backend Engineer',
      'Backend Engineering Intern',
      'Engineering Manager, Backend',
    ]) {
      expect([title, passesBasicFilters({ ...base, title }, c, now)]).toEqual([title, false]);
    }
    for (const [title, flag] of [
      ['Staff Backend Engineer', 'seniority:staff'],
      ['Senior Staff Software Engineer, Platform', 'seniority:staff'],
      ['Principal Backend Engineer', 'seniority:principal'],
    ]) {
      const job = { ...base, title };
      expect([title, passesBasicFilters(job, c, now)]).toEqual([title, true]);
      expect(assessEligibility(job, c, now).flags).toContain(flag);
    }
  });

  it('matches keywords on token boundaries', () => {
    expect(titleHas('senior .net developer', '.net')).toBe(true);
    expect(titleHas('javascript engineer', 'java')).toBe(false);
    expect(titleHas('capital markets backend', 'api')).toBe(false);
  });
});

describe('feed parsers (recorded payload shapes)', () => {
  it('parses Remotive', () => {
    const [j] = parseRemotive({
      jobs: [{ id: 1, url: 'https://remotive.com/remote-jobs/software-dev/backend-1', title: 'Senior Backend Engineer', company_name: 'Acme', candidate_required_location: 'Worldwide', publication_date: '2026-10-01T10:00:00', salary: '$80k - $100k', description: '<p>Node.js and <b>PostgreSQL</b></p>' }],
    });
    expect(j).toMatchObject({ provider: 'REMOTIVE', externalId: '1', companyName: 'Acme', location: 'Remote (Worldwide)', remote: true, salaryText: '$80k - $100k' });
    expect(j.description).toContain('Node.js and PostgreSQL');
  });

  it('parses Himalayas, Jobicy, Arbeitnow and Remote OK', () => {
    expect(parseHimalayas({ jobs: [{ guid: 'g1', title: 'Backend Engineer', companyName: 'Beta', locationRestrictions: ['India'], pubDate: 1759700000, description: '<p>Go</p>', applicationLink: 'https://himalayas.app/x' }] })[0]).toMatchObject({ location: 'Remote (India)', externalId: 'g1' });
    expect(parseJobicy({ jobs: [{ id: 7, url: 'https://jobicy.com/jobs/7', jobTitle: 'Node.js Developer', companyName: 'Gamma', jobGeo: 'APAC', pubDate: '2026-10-02 09:00:00', jobDescription: '<p>x</p>', annualSalaryMin: 50000, annualSalaryMax: 70000, salaryCurrency: 'USD' }] })[0]).toMatchObject({ location: 'Remote (APAC)', salaryText: 'USD 50000 - 70000 per year' });
    expect(parseArbeitnow({ data: [{ slug: 'a-1', company_name: 'Delta', title: 'Backend Dev', remote: false, url: 'https://arbeitnow.com/a-1', location: 'Berlin', created_at: 1759700000 }] })[0]).toMatchObject({ location: 'Berlin', remote: false });
    const rok = parseRemoteOk([{ legal: 'API terms' } as never, { id: 9, position: 'Senior Backend Engineer', company: 'Epsilon', location: 'Worldwide', date: '2026-10-03T00:00:00Z', url: 'https://remoteok.com/remote-jobs/9', tags: ['node', 'aws'] }]);
    expect(rok).toHaveLength(1);
    expect(rok[0].description).toContain('Tags: node, aws');
  });

  it('parses a Hacker News "Who is hiring" comment, with the published email as a contact', () => {
    const job = parseHnComment({
      objectID: '123',
      created_at: '2026-10-02T10:00:00Z',
      comment_text:
        'Acme Pay (<a href="https:&#x2F;&#x2F;acmepay.io">https:&#x2F;&#x2F;acmepay.io</a>) | Senior Backend Engineer (Node.js) | REMOTE (Worldwide) | Full-time<p>I&#x27;m the CTO. We build payment APIs with Node.js, Postgres and Redis.<p>Email me: jane [at] acmepay [dot] io',
    })!;
    expect(job).toMatchObject({ provider: 'HN_HIRING', companyName: 'Acme Pay', title: 'Senior Backend Engineer (Node.js)', remote: true, companyDomain: 'acmepay.io', url: 'https://news.ycombinator.com/item?id=123' });
    expect(job.location).toContain('REMOTE');
    expect(job.contacts).toEqual([expect.objectContaining({ email: 'jane@acmepay.io', roleCategory: 'CTO', confidence: 'VERIFIED', source: 'hn_hiring' })]);
    expect(parseHnComment({ objectID: '1', comment_text: 'Just a reply without pipes' })).toBeNull();
  });

  it('extracts plain and lightly obfuscated emails, never inventing any', () => {
    expect(extractEmails('write to jobs@acme.io or bob (at) acme (dot) io')).toEqual(['jobs@acme.io', 'bob@acme.io']);
    expect(extractEmails('we work at Acme on hard problems')).toEqual([]);
    expect(extractEmails('contact you@example.com')).toEqual([]);
  });

  it('parses the We Work Remotely RSS feed', () => {
    const xml = `<?xml version="1.0"?><rss><channel><item>
      <title>Zeta Labs: Senior Node.js Engineer</title><region>Anywhere in the World</region><skills>Node.js, AWS</skills><type>Full-Time</type>
      <description>&lt;p&gt;&lt;strong&gt;URL:&lt;/strong&gt; &lt;a href="https://zeta.dev"&gt;https://zeta.dev&lt;/a&gt;&lt;/p&gt;&lt;p&gt;Build APIs&lt;/p&gt;</description>
      <pubDate>Thu, 02 Oct 2026 10:00:00 +0000</pubDate><link>https://weworkremotely.com/remote-jobs/zeta-node</link></item></channel></rss>`;
    const [j] = parseWwrRss(xml);
    expect(j).toMatchObject({ provider: 'WWR', companyName: 'Zeta Labs', title: 'Senior Node.js Engineer', companyDomain: 'zeta.dev', location: 'Remote (Anywhere in the World)' });
    expect(j.description).toContain('Skills: Node.js, AWS');
  });
});

describe('default sources', () => {
  it('ships unique, well-formed sources (feeds + company boards with domains)', () => {
    const keys = DEFAULT_SOURCES.map((s) => `${s.provider}:${s.name}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(DEFAULT_SOURCES.filter((s) => ['GREENHOUSE', 'ASHBY'].includes(s.provider)).every((s) => s.config.boardToken && s.config.domain)).toBe(true);
    expect(DEFAULT_SOURCES.length).toBeGreaterThan(30);
  });
});

describe('follow-up cadence', () => {
  it('defaults to day 4, 9 and 16 after the first email', () => {
    expect(cumulativeDays(resolveSettings({}).followups.delaysDays)).toEqual([4, 9, 16]);
    expect(relativeDays([4, 9, 16])).toEqual([4, 5, 7]);
    expect(relativeDays([16, 4, 9])).toEqual([4, 5, 7]);
  });
});


// ─── Regression tests for defects found by the Phase 1 discovery audit ──────────

const fullCriteria: JobSearchCriteria = {
  ...criteria,
  titleKeywords: ['backend engineer', 'software engineer', 'backend', 'platform'],
  excludeTitleKeywords: DEFAULT_EXCLUDE_TITLES,
  locations: ['India', 'Bengaluru', 'Gurugram'],
  includeRemote: true,
};
const recent = new Date('2026-10-01');
const job = (over: Record<string, unknown>) => ({ title: 'Senior Backend Engineer', location: 'Remote (Worldwide)', remote: true, postedAt: recent, ...over });

describe('region rules (regression: live leaks found on 2026-10-23)', () => {
  it('drops Europe/US-restricted remote roles that the old blacklist let through', () => {
    for (const location of ['Remote (Italy)', 'Remote (Czechia,  Hungary,  Ukraine)', 'Remote (Winterthur)', 'Remote (Zürich)', 'Remote - SF Bay Area', 'Remote - CA', 'Remote (Sao Paulo)', 'Remote (Belgium)']) {
      expect([location, passesBasicFilters(job({ location }), fullCriteria, now)]).toEqual([location, false]);
    }
  });

  it('keeps India-compatible remote roles, including India\'s own timezone', () => {
    for (const location of ['Remote (UTC+5:30)', 'Remote - IST', 'Remote (GMT+5:30)', 'Remote (Europe or India)', 'Remote (APAC)', 'Remote (Anywhere in the World)', 'Remote']) {
      expect([location, passesBasicFilters(job({ location }), fullCriteria, now)]).toEqual([location, true]);
    }
    // A single other country is an explicit restriction, even in APAC: only explicitly open regions count.
    expect(passesBasicFilters(job({ location: 'Remote (Philippines)' }), fullCriteria, now)).toBe(false);
    // Other offsets are still region-locked.
    expect(passesBasicFilters(job({ location: 'Remote (UTC-5)' }), fullCriteria, now)).toBe(false);
    expect(passesBasicFilters(job({ location: 'Remote (UTC+1)' }), fullCriteria, now)).toBe(false);
  });

  it('matches target locations as whole words ("Indianapolis" is not India)', () => {
    expect(passesBasicFilters(job({ location: 'Indianapolis, IN', remote: false }), fullCriteria, now)).toBe(false);
    expect(passesBasicFilters(job({ location: 'Bengaluru, Karnataka', remote: false }), fullCriteria, now)).toBe(true);
    expect(passesBasicFilters(job({ location: 'Gurugram', remote: false }), fullCriteria, now)).toBe(true);
  });
});

describe('title rules', () => {
  const flagged = { ...fullCriteria, flagTitleKeywords: FLAG_TITLES };

  it('"Staff+" is staff level (flagged); "c++" and "java" keep matching on token boundaries', () => {
    const j = job({ title: 'Software Engineer (Staff+ level)' });
    expect(passesBasicFilters(j, fullCriteria, now)).toBe(true);
    expect(assessEligibility(j, flagged, now).flags).toContain('seniority:staff');
    expect(titleHas('senior c++ developer', 'c++')).toBe(true);
    expect(titleHas('c++ developer', 'c')).toBe(false);
    expect(titleHas('javascript engineer', 'java')).toBe(false);
    expect(titleHas('java+kotlin engineer', 'java')).toBe(true);
  });

  it('does not mistake "Member of Technical Staff" for the staff seniority level', () => {
    const mts = job({ title: 'Member of Technical Staff, Backend' });
    expect(passesBasicFilters(mts, fullCriteria, now)).toBe(true);
    expect(assessEligibility(mts, flagged, now).flags.filter((f) => f.startsWith('seniority'))).toEqual([]);
    expect(assessEligibility(job({ title: 'Principal Member of Technical Staff, Backend' }), flagged, now).flags).toContain('seniority:principal');
  });

  it('accepts any engineering title and rejects other functions (regression: "Software Development Engineer" was dropped)', () => {
    const c = { ...fullCriteria, titleKeywords: [], requireEngineering: true };
    for (const title of ['Software Development Engineer - Tejas', 'SDE 2', 'Postgres Engineer', 'Agent Engineer', 'Member of Technical Staff', 'Infrastructure SRE - HPC', 'Platform Engineer', 'Backend Developer', 'Staff Engineer, API Platform', 'Solutions Architect Engineer II']) {
      const r = basicFilterReason(job({ title }), c, now);
      expect([title, r === 'title:not-engineering']).toEqual([title, false]);
    }
    for (const title of ['Account Executive', 'Product Designer', 'Technical Recruiter', 'Head of People']) {
      expect([title, basicFilterReason(job({ title }), c, now)]).toEqual([title, 'title:not-engineering']);
    }
    for (const title of ['Frontend Engineer', 'Support Engineer', 'Sales Engineer', 'Developer Relations Engineer', 'Engineering Manager', 'iOS Engineer']) {
      expect([title, basicFilterReason(job({ title }), { ...c, excludeTitleKeywords: DEFAULT_EXCLUDE_TITLES }, now)]).toEqual([title, 'title:excluded']);
    }
  });
});

describe('explainable rejections', () => {
  it('returns a reason code for every kind of rejection, and null for a pass', () => {
    expect(basicFilterReason(job({}), fullCriteria, now)).toBeNull();
    expect(basicFilterReason(job({ title: 'Office Manager' }), fullCriteria, now)).toBe('title:no-keyword');
    expect(basicFilterReason(job({ title: 'Account Executive' }), { ...fullCriteria, titleKeywords: [], requireEngineering: true }, now)).toBe('title:not-engineering');
    expect(basicFilterReason(job({ title: 'Frontend Software Engineer' }), fullCriteria, now)).toBe('title:excluded');
    expect(basicFilterReason(job({ location: 'Remote (US only)' }), fullCriteria, now)).toBe('region:remote-not-india-compatible');
    expect(basicFilterReason(job({ location: 'Berlin', remote: false }), fullCriteria, now)).toBe('region:onsite-outside-targets');
    expect(basicFilterReason(job({ postedAt: new Date('2026-08-01') }), fullCriteria, now)).toBe('age:too-old');
  });

  it('filterListed counts what it listed and why it dropped the rest', () => {
    const stats = { fetched: 0 } as NonNullable<JobSearchCriteria['stats']>;
    const mk = (title: string, location = 'Remote (Worldwide)') => ({ provider: 'REMOTIVE' as const, title, companyName: 'Acme', location, remote: true, description: 'x'.repeat(60), postedAt: new Date() });
    const kept = filterListed([mk('Senior Backend Engineer'), mk('Frontend Software Engineer'), mk('Software Engineer, iOS'), mk('Backend Engineer', 'Remote (Italy)')], { ...fullCriteria, stats });
    expect(kept).toHaveLength(1);
    expect(stats).toEqual({ fetched: 4, rejected: { 'title:excluded': 2, 'region:remote-not-india-compatible': 1 } });
  });
});

describe('date parsing', () => {
  it('parses every format the sources really use, and never returns an Invalid Date', () => {
    expect(parseDate('Wed, 21 Oct 2026 13:46:32 +0000')?.toISOString()).toBe('2026-10-21T13:46:32.000Z'); // RSS (We Work Remotely)
    expect(parseDate('2026-10-02T09:00:00Z')?.toISOString()).toBe('2026-10-02T09:00:00.000Z');
    expect(parseDate('2026-10-02 09:00:00')).toBeInstanceOf(Date); // Jobicy
    expect(parseDate(1759700000)?.getUTCFullYear()).toBe(2025); // epoch seconds
    expect(parseDate('1759700000')?.getUTCFullYear()).toBe(2025); // epoch seconds as string
    expect(parseDate(1759700000000)?.getUTCFullYear()).toBe(2025); // epoch millis
    for (const bad of ['garbage', '', null, undefined, '0000-00-00', NaN]) expect([bad, parseDate(bad)]).toEqual([bad, null]);
  });

  it('We Work Remotely items keep their publication date (the 30-day filter needs it)', () => {
    const xml = '<rss><channel><item><title>Zeta: Backend Engineer</title><pubDate>Wed, 21 Oct 2026 13:46:32 +0000</pubDate><link>https://x/1</link><description>d</description></item></channel></rss>';
    expect(parseWwrRss(xml)[0].postedAt?.toISOString()).toBe('2026-10-21T13:46:32.000Z');
    const stale = xml.replace('21 Oct 2026', '01 Aug 2026');
    expect(passesBasicFilters(parseWwrRss(stale)[0], { ...fullCriteria, locations: [], includeRemote: false }, now)).toBe(false);
  });
});

describe('Hacker News header parsing', () => {
  it('does not take the company pitch for a location (it could trip the region filter)', () => {
    const j = parseHnComment({
      objectID: '5',
      created_at: '2026-10-02T10:00:00Z',
      comment_text: 'Acme | Backend Engineer | Remote | We build payment rails for US banks and credit unions<p>Apply: jobs@acme.io',
    })!;
    expect(j.location).toBe('Remote');
    expect(passesBasicFilters(j, { ...fullCriteria, titleKeywords: ['backend engineer'] }, now)).toBe(true);
    const k = parseHnComment({ objectID: '6', created_at: '2026-10-02T10:00:00Z', comment_text: 'Acme | Backend Engineer | Bangalore | Our business is growing<p>jobs@acme.io' })!;
    expect(k.location).toBe('Bangalore');
    const l = parseHnComment({ objectID: '7', created_at: '2026-10-02T10:00:00Z', comment_text: 'Acme | Backend Engineer | Remote (Global) · https://acme.io/jobs Acme is a nonprofit<p>jobs@acme.io' })!;
    expect(l.location).toBe('Remote'); // the link fragment is dropped; the header still says remote
  });
});

describe('providers against mocked upstreams', () => {
  const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } });
  const jd = '<p>Backend role. 3+ years building backend systems with Node.js, TypeScript and PostgreSQL.</p>';
  const urlOf = (i: string | URL | Request) => (typeof i === 'string' ? i : i instanceof URL ? i.toString() : i.url);
  let urls: string[];
  beforeEach(() => {
    urls = [];
    httpRetry.baseDelayMs = 1;
  });
  afterEach(() => {
    jest.restoreAllMocks();
    httpRetry.baseDelayMs = 700;
  });

  it('Greenhouse, Lever and Ashby turn malformed dates into "unknown" instead of Invalid Date', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (i) => {
      const u = urlOf(i);
      if (u.endsWith('/boards/acme')) return json({ name: 'Acme' });
      if (u.endsWith('/boards/acme/jobs')) return json({ jobs: [{ id: 1, title: 'Senior Backend Engineer', absolute_url: 'u1', location: { name: 'Bengaluru, India' }, first_published: 'garbage', updated_at: 'also-garbage' }] });
      if (u.endsWith('/boards/acme/jobs/1')) return json({ id: 1, title: 'Senior Backend Engineer', absolute_url: 'u1', location: { name: 'Bengaluru, India' }, first_published: 'garbage', content: jd });
      if (u.includes('api.lever.co')) return json([{ id: 'l1', text: 'Senior Backend Engineer', hostedUrl: 'u2', createdAt: 'abc', descriptionPlain: jd, categories: { location: 'Bengaluru, India' } }]);
      if (u.includes('api.ashbyhq.com')) return json({ jobs: [{ id: 'a1', title: 'Senior Backend Engineer', location: 'Bengaluru, India', publishedAt: 'garbage', descriptionPlain: jd }] });
      throw new Error('unexpected ' + u);
    });
    const [gh] = await new GreenhouseProvider().searchJobs(fullCriteria, { boardToken: 'acme' });
    const [lv] = await new LeverProvider().searchJobs(fullCriteria, { boardToken: 'acme' });
    const [ab] = await new AshbyProvider().searchJobs(fullCriteria, { boardToken: 'acme' });
    expect([gh.postedAt, lv.postedAt, ab.postedAt]).toEqual([null, null, null]);
  });

  it('Greenhouse reads the newest postings first when it must cap detail requests, and reports failed details', async () => {
    const list = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, title: 'Senior Backend Engineer', absolute_url: `u${i + 1}`, location: { name: 'Bengaluru, India' }, first_published: new Date(Date.now() - (100 - i) * 3_600_000).toISOString() }));
    jest.spyOn(global, 'fetch').mockImplementation(async (i) => {
      const u = urlOf(i);
      urls.push(u);
      if (u.endsWith('/boards/acme')) return json({ name: 'Acme' });
      if (u.endsWith('/boards/acme/jobs')) return json({ jobs: list });
      const id = Number(/jobs\/(\d+)$/.exec(u)![1]);
      return id === 100 ? json({}, 404) : json({ ...list[id - 1], content: jd });
    });
    const stats = { fetched: 0 } as NonNullable<JobSearchCriteria['stats']>;
    const out = await new GreenhouseProvider().searchJobs({ ...fullCriteria, postedWithinDays: 30, stats }, { boardToken: 'acme' });
    expect(urls.filter((u) => /jobs\/\d+$/.test(u))).toHaveLength(80);
    expect(urls).toContain('https://boards-api.greenhouse.io/v1/boards/acme/jobs/99'); // newest are read ...
    expect(urls).not.toContain('https://boards-api.greenhouse.io/v1/boards/acme/jobs/1'); // ... oldest are the ones skipped
    expect(out).toHaveLength(79);
    expect(stats.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/20 matching postings beyond the newest 80/), expect.stringMatching(/1 of 80 job details failed/)]));
  });

  it('Himalayas pages by the size the server reports (it caps pages at 20 whatever ?limit says)', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (i) => {
      const u = urlOf(i);
      urls.push(u);
      const offset = Number(new URL(u).searchParams.get('offset'));
      return json({ limit: 20, offset, jobs: Array.from({ length: 20 }, (_, k) => ({ guid: `g${offset + k}`, title: 'Backend Engineer', companyName: 'C', description: jd, pubDate: Math.floor(Date.now() / 1000) })) });
    });
    const out = await new HimalayasProvider().searchJobs({ ...fullCriteria, locations: [], includeRemote: false });
    expect(urls.map((u) => Number(new URL(u).searchParams.get('offset'))).sort((a, b) => a - b)).toEqual([0, 20, 40, 60, 80, 100, 120, 140, 160, 180]);
    expect(new Set(out.map((j) => j.externalId)).size).toBe(200); // contiguous, no gaps
  });

  it('Himalayas reports pages that failed instead of silently returning fewer jobs', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (i) => {
      const offset = Number(new URL(urlOf(i)).searchParams.get('offset'));
      return offset === 60 ? json({}, 500) : json({ limit: 20, jobs: [{ guid: `g${offset}`, title: 'Backend Engineer', companyName: 'C', description: jd }] });
    });
    const stats = { fetched: 0 } as NonNullable<JobSearchCriteria['stats']>;
    const out = await new HimalayasProvider().searchJobs({ ...fullCriteria, locations: [], includeRemote: false, stats });
    expect(out).toHaveLength(9);
    expect(stats.warnings).toEqual([expect.stringMatching(/Himalayas: 1 of 10 pages failed/)]);
  });

  it('Arbeitnow pages larger than the default 3 MB response cap are still read (page 1 is ~4 MB in production)', async () => {
    const bigPage = (page: number) => json({ data: Array.from({ length: 300 }, (_, i) => ({ slug: `p${page}-${i}`, company_name: 'C', title: 'Backend Engineer', remote: true, location: 'Anywhere', url: 'u', description: 'x'.repeat(11_000), created_at: Math.floor(Date.now() / 1000) })) });
    jest.spyOn(global, 'fetch').mockImplementation(async (i) => bigPage(Number(new URL(urlOf(i)).searchParams.get('page'))));
    const stats = { fetched: 0 } as NonNullable<JobSearchCriteria['stats']>;
    const { ArbeitnowProvider } = await import('./aggregators');
    const out = await new ArbeitnowProvider().searchJobs({ ...fullCriteria, locations: [], includeRemote: false, limit: 1000, stats });
    expect(stats.fetched).toBe(600);
    expect(stats.warnings).toBeUndefined();
    expect(out).toHaveLength(600);
  });

  it('We Work Remotely reports feeds that failed while others worked', async () => {
    const rss = `<rss><channel><item><title>Zeta: Senior Backend Engineer</title><region>Anywhere in the World</region><description>${jd.replace(/</g, '&lt;')}</description><pubDate>${new Date().toUTCString()}</pubDate><link>https://wwr/z1</link></item></channel></rss>`;
    jest.spyOn(global, 'fetch').mockImplementation(async (i) => (urlOf(i).includes('back-end') ? new Response(rss, { status: 200 }) : new Response('boom', { status: 500 })));
    const stats = { fetched: 0 } as NonNullable<JobSearchCriteria['stats']>;
    const out = await new WeWorkRemotelyProvider().searchJobs({ ...fullCriteria, stats });
    expect(out).toHaveLength(1);
    expect(stats.warnings).toEqual([expect.stringMatching(/2 of 3 feeds failed.*HTTP 500/)]);
  });
});

describe('transient upstream failures are retried (and permanent ones are not)', () => {
  beforeEach(() => {
    httpRetry.baseDelayMs = 1;
  });
  afterEach(() => {
    jest.restoreAllMocks();
    httpRetry.baseDelayMs = 700;
  });

  it('retries 503/429 and succeeds, honouring Retry-After', async () => {
    const spy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    const { fetchJson } = await import('../http');
    await expect(fetchJson('https://example.test/x')).resolves.toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('gives up after the retry budget and surfaces the error', async () => {
    const spy = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response('', { status: 503 }));
    const { fetchJson } = await import('../http');
    await expect(fetchJson('https://example.test/x')).rejects.toThrow(/HTTP 503/);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('retries a dropped connection but never a firewall interception, a 404, or retries=0 callers', async () => {
    const { fetchJson } = await import('../http');
    jest.restoreAllMocks();
    const reset = jest.spyOn(global, 'fetch').mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })).mockResolvedValueOnce(new Response('{"a":1}', { status: 200 }));
    await expect(fetchJson('https://example.test/x')).resolves.toEqual({ a: 1 });
    expect(reset).toHaveBeenCalledTimes(2);

    jest.restoreAllMocks();
    const tls = jest.spyOn(global, 'fetch').mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } }));
    await expect(fetchJson('https://example.test/x')).rejects.toBeInstanceOf(FetchError);
    expect(tls).toHaveBeenCalledTimes(1);

    jest.restoreAllMocks();
    const nf = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response('', { status: 404 }));
    await expect(fetchJson('https://example.test/x')).rejects.toThrow(/Not found/);
    expect(nf).toHaveBeenCalledTimes(1);

    jest.restoreAllMocks();
    const once = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response('', { status: 503 }));
    expect((await httpFetch('https://example.test/robots.txt')).status).toBe(503); // default: no retries
    expect(once).toHaveBeenCalledTimes(1);
  });
});

// ─── Two-tier eligibility: hard rules reject, everything else is kept and flagged ────

describe('location whitelist (what is explicitly open to a candidate in India?)', () => {
  it('classifies places as india / global / unspecified / restricted', () => {
    const table: Array<[string | null | undefined, string]> = [
      ['Bengaluru, India', 'india'],
      ['Remote - India', 'india'],
      ['San Francisco; Bengaluru', 'india'],
      ['Remote (Worldwide)', 'global'],
      ['Remote, Global', 'global'],
      ['Remote - APAC', 'global'],
      ['Home Based - Americas; Home Based - APAC', 'global'], // Canonical
      ['Remote (UTC+5:30)', 'global'],
      ['Anywhere in the World', 'global'],
      ['Remote', 'unspecified'],
      ['Remote.', 'unspecified'],
      ['Fully Remote', 'unspecified'],
      ['Hybrid', 'unspecified'],
      ['N/A', 'unspecified'], // Stripe
      ['TBD', 'unspecified'],
      ['', 'unspecified'],
      [null, 'unspecified'],
      ['Remote - USA', 'restricted'],
      ['Remote (Europe)', 'restricted'],
      ['Denver, Colorado', 'restricted'], // not on any blacklist, still not open to India
      ['Krakow', 'restricted'],
      ['NY, SF or Remote', 'restricted'],
      ['Remote (Philippines)', 'restricted'],
      ['Indianapolis, IN', 'restricted'],
    ];
    for (const [loc, want] of table) expect([loc, classifyLocation(loc)]).toEqual([loc, want]);
    expect(remoteRegionOk('Remote')).toBe(true);
    expect(remoteRegionOk('Remote - Denver')).toBe(false);
  });

  it('a remote flag does not rescue an explicit foreign place', () => {
    for (const location of ['Denver, Colorado', 'Krakow', 'Waterloo, Canada']) {
      expect([location, basicFilterReason(job({ location, remote: true }), fullCriteria, now)]).toEqual([location, 'region:remote-not-india-compatible']);
    }
  });
});

describe('uncertain listings are kept with explicit metadata', () => {
  const c = { ...fullCriteria, flagTitleKeywords: FLAG_TITLES, staleAfterDays: 30 };

  it('an unstated region is UNCERTAIN, not rejected', () => {
    for (const location of [null, '', 'N/A', 'Remote']) {
      const j = job({ location, remote: location === 'Remote' });
      expect([location, basicFilterReason(j, c, now)]).toEqual([location, null]);
      expect(assessEligibility(j, c, now).status).toBe('UNCERTAIN');
    }
    expect(assessEligibility(job({ location: 'Remote', remote: true }), c, now).flags).toContain('location:remote-region-unstated');
    expect(assessEligibility(job({ location: null, remote: false }), c, now).flags).toContain('location:unspecified');
  });

  it('an explicit India or worldwide location is ELIGIBLE', () => {
    for (const location of ['Bengaluru, India', 'Remote (Worldwide)', 'Remote - APAC']) expect(assessEligibility(job({ location }), c, now).status).toBe('ELIGIBLE');
  });

  it('flags missing dates, old postings, stack mismatch and adjacent disciplines instead of rejecting them', () => {
    const f = (over: Record<string, unknown>) => assessEligibility(job(over), c, now).flags;
    expect(f({ postedAt: null })).toContain('age:unknown');
    expect(f({ postedAt: new Date('2026-06-01') })).toContain('age:older-than-30d');
    expect(f({ postedAt: new Date('2026-10-20') }).filter((x) => x.startsWith('age'))).toEqual([]);
    expect(f({ title: 'Senior Java Backend Engineer' })).toContain('stack:java');
    expect(f({ title: 'Senior Data Engineer' })).toContain('adjacent:data engineer');
    expect(f({ title: 'Senior Backend Engineer, Node.js' })).toEqual([]);
  });
});

describe('posting age: company boards vs feeds', () => {
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  const old = new Date('2025-10-14').toISOString();
  afterEach(() => jest.restoreAllMocks());

  it('a role still listed on a company board is open today, however old its first publication', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (i) => {
      const u = typeof i === 'string' ? i : i instanceof URL ? i.toString() : i.url;
      if (u.endsWith('/boards/acme')) return json({ name: 'Acme' });
      if (u.endsWith('/boards/acme/jobs')) return json({ jobs: [{ id: 1, title: 'Senior Software Engineer - Backend', absolute_url: 'u', location: { name: 'Bengaluru, India' }, first_published: old }] });
      return json({ id: 1, title: 'Senior Software Engineer - Backend', absolute_url: 'u', location: { name: 'Bengaluru, India' }, first_published: old, content: '&lt;p&gt;Backend role with Node.js, PostgreSQL and AWS experience.&lt;/p&gt;' });
    });
    const stats = { fetched: 0 } as NonNullable<JobSearchCriteria['stats']>;
    const out = await new GreenhouseProvider().searchJobs({ ...fullCriteria, postedWithinDays: 30, stats }, { boardToken: 'acme' });
    expect(out).toHaveLength(1);
    expect(stats.rejected).toBeUndefined();
    expect(assessEligibility(out[0], { ...fullCriteria, staleAfterDays: 30 }, now).flags).toContain('age:older-than-30d');
  });

  it('aggregator feeds still drop stale postings (they keep dead listings around)', () => {
    expect(basicFilterReason(job({ postedAt: new Date('2026-08-01') }), { ...fullCriteria, postedWithinDays: 30 }, now)).toBe('age:too-old');
  });
});

describe('quality guards found by the end-to-end dry run', () => {
  const c = { ...fullCriteria, titleKeywords: [], requireEngineering: true, excludeTitleKeywords: DEFAULT_EXCLUDE_TITLES };

  it('non-software engineering fields and engineering leadership are hard-rejected', () => {
    for (const title of ['Senior Mechanical Design Engineer, Special Projects', 'Electrical Engineer', 'Civil Engineer', 'Manufacturing Engineer', 'FPGA Engineer', 'Validation Engineer', 'Engineering Leader, Platform Engineering', 'Field Engineer']) {
      expect([title, basicFilterReason(job({ title }), c, now)]).toEqual([title, 'title:excluded']);
    }
    for (const title of ['Senior Backend Engineer', 'Software Engineer, Infrastructure', 'Platform Engineer', 'Tech Lead, Backend', 'Payments Backend Engineer']) {
      expect([title, basicFilterReason(job({ title }), c, now)]).toEqual([title, null]);
    }
  });

  it('reads the region from the title when the location only says "Remote"', () => {
    expect(classifyPosting('Remote', 'Software Engineer - Latam')).toBe('restricted');
    expect(classifyPosting('Remote', 'Support Engineer (EMEA)')).toBe('restricted');
    expect(classifyPosting('Remote', 'Backend Engineer (US)')).toBe('restricted');
    expect(classifyPosting('Remote', 'Backend Software Engineer - India')).toBe('india');
    expect(classifyPosting('Remote', 'Senior Engineer, APAC')).toBe('global');
    expect(classifyPosting('Remote', 'Senior Backend Engineer')).toBe('unspecified');
    expect(classifyPosting('Remote', 'Senior Engineer, American Express Integrations')).toBe('unspecified');
    // A stated location always wins over the title.
    expect(classifyPosting('Bengaluru, India', 'Engineer (US Payments)')).toBe('india');
    expect(basicFilterReason(job({ title: 'Software Engineer - Latam', location: 'Remote', remote: true }), c, now)).toBe('region:remote-not-india-compatible');
    expect(assessEligibility(job({ title: 'Backend Engineer - India', location: 'Remote', remote: true }), c, now).status).toBe('ELIGIBLE');
  });
});
