import { cumulativeDays, relativeDays, resolveSettings } from '../../domain/settings';
import { extractEmails, parseArbeitnow, parseHimalayas, parseHnComment, parseJobicy, parseRemoteOk, parseRemotive, parseWwrRss } from './aggregators';
import { DEFAULT_SOURCES } from './default-sources';
import { passesBasicFilters, remoteRegionOk, titleHas } from './job-provider.interface';

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
