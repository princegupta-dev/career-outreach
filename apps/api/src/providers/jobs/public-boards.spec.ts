import { freshnessTier, searchPlan, DISCOVERY_QUERIES, LOCATION_VARIANTS } from './discovery-queries';
import { experienceFromText, parseRecruitee, parseWorkable, parseYcDetail, parseYcListing, postingLinks, ycAgeToDate } from './public-boards';
import { SOURCE_CATALOG } from './source-catalog';

const now = new Date('2026-10-07T10:00:00Z');
const attr = (o: unknown) => JSON.stringify(o).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

describe('Workable public widget API', () => {
  it('maps postings, remote flag, application URL and experience', () => {
    const jobs = parseWorkable(
      {
        name: 'Acme',
        jobs: [
          {
            title: 'Senior Backend Engineer',
            shortcode: 'AB12CD',
            url: 'https://apply.workable.com/acme/j/AB12CD/',
            application_url: 'https://apply.workable.com/acme/j/AB12CD/apply/',
            published_on: '2026-10-06',
            telecommuting: true,
            locations: [{ city: 'Bengaluru', country: 'India' }],
            description: '<p>Node.js, TypeScript and Redis. 4+ years of backend experience.</p>',
          },
        ],
      },
      'acme',
    );
    expect(jobs[0]).toMatchObject({
      provider: 'WORKABLE',
      externalId: 'acme:AB12CD',
      companyName: 'Acme',
      location: 'Remote / Bengaluru, India',
      remote: true,
      applicationUrl: 'https://apply.workable.com/acme/j/AB12CD/apply/',
      experienceText: '4+ years',
    });
    expect(jobs[0].postedAt?.toISOString()).toBe('2026-10-06T00:00:00.000Z');
  });
});

describe('Recruitee public offers API', () => {
  it('maps offers including requirements text', () => {
    const [job] = parseRecruitee(
      {
        offers: [
          {
            id: 77,
            slug: 'backend-engineer',
            title: 'Backend Engineer',
            description: '<p>Build APIs.</p>',
            requirements: '<ul><li>3-5 years with NestJS</li></ul>',
            location: 'Pune, India',
            remote: false,
            careers_url: 'https://acme.recruitee.com/o/backend-engineer',
            careers_apply_url: 'https://acme.recruitee.com/o/backend-engineer/c/new',
            published_at: '2026-10-05 08:00:00 UTC',
            company_name: 'Acme',
          },
        ],
      },
      'acme',
    );
    expect(job).toMatchObject({ provider: 'RECRUITEE', externalId: 'acme:77', location: 'Pune, India', applicationUrl: 'https://acme.recruitee.com/o/backend-engineer/c/new', experienceText: '3-5 years' });
    expect(job.description).toMatch(/NestJS/);
  });
});

describe('YC jobs pages', () => {
  const listing = `<div id="app" data-page="${attr({
    component: 'WaasJobListingsPage',
    props: {
      jobPostings: [
        { id: 92733, title: 'Senior Backend Engineer', url: '/companies/paylane/jobs/abc-senior-backend-engineer', location: 'Remote (IN)', type: 'Full-time', salaryRange: '₹30L - ₹45L INR', minExperience: '3+ years', companyName: 'PayLane', createdAt: '3 days' },
      ],
    },
  })}"></div>`;
  it('parses listings with approximate posting dates', () => {
    const [j] = parseYcListing(listing, now);
    expect(j).toMatchObject({ provider: 'YC_JOBS', externalId: '92733', url: 'https://www.ycombinator.com/companies/paylane/jobs/abc-senior-backend-engineer', remote: true, experienceText: '3+ years' });
    expect(j.postedAt?.toISOString()).toBe('2026-10-04T10:00:00.000Z');
  });
  it('reads description, website and founders (names only — never an email)', () => {
    const html = `<div data-page="${attr({
      props: {
        job: { id: 92733, title: 'Senior Backend Engineer', description: '<p>We use Node.js, NestJS & PostgreSQL.</p>' },
        company: { name: 'PayLane', website: 'https://www.paylane.dev', founders: [{ full_name: 'Asha Rao', title: 'Co-founder & CTO' }] },
      },
    })}"></div>`;
    const d = parseYcDetail(html, 'https://www.ycombinator.com/companies/paylane/jobs/abc')!;
    expect(d.description).toMatch(/Node\.js, NestJS & PostgreSQL/);
    expect(d.companyDomain).toBe('paylane.dev');
    expect(d.contacts).toEqual([expect.objectContaining({ name: 'Asha Rao', roleCategory: 'CTO', email: null, sourceType: 'YC_PAGE', verificationStatus: 'UNKNOWN' })]);
  });
  it('converts YC relative ages', () => {
    expect(ycAgeToDate('about 1 month', now)?.toISOString()).toBe('2026-09-07T10:00:00.000Z');
    expect(ycAgeToDate('5 hours', now)?.toISOString()).toBe('2026-10-07T05:00:00.000Z');
    expect(ycAgeToDate(undefined, now)).toBeNull();
  });
});

describe('career pages and search plan', () => {
  it('finds same-site posting links only', () => {
    const html = `<a href="/careers/senior-backend-engineer">a</a><a href="https://acme.com/jobs/123/node-dev">b</a><a href="https://evil.com/jobs/1/x">c</a><a href="/about">d</a><a href="/careers/">e</a>`;
    expect(postingLinks(html, 'https://acme.com/careers/')).toEqual(['https://acme.com/careers/senior-backend-engineer', 'https://acme.com/jobs/123/node-dev']);
  });
  it('extracts experience requirements', () => {
    expect(experienceFromText('We need 5+ years building APIs')).toBe('5+ years');
    expect(experienceFromText('No requirement')).toBeNull();
  });
  it('covers every query with diverse locations and respects the cap', () => {
    const plan = searchPlan(12);
    expect(plan).toHaveLength(12);
    expect(new Set(plan.map((p) => DISCOVERY_QUERIES.find((q) => p.startsWith(q))))).toEqual(new Set(DISCOVERY_QUERIES));
    expect(new Set(plan.map((p) => LOCATION_VARIANTS.find((l) => p.endsWith(l)))).size).toBeGreaterThan(8);
    expect(new Set(searchPlan(1000)).size).toBe(DISCOVERY_QUERIES.length * LOCATION_VARIANTS.length);
  });
  it('buckets postings by freshness', () => {
    const h = (n: number) => new Date(now.getTime() - n * 3600_000);
    expect([freshnessTier(h(60), now), freshnessTier(h(100), now), freshnessTier(h(500), now), freshnessTier(null, now)]).toEqual(['72h', '7d', 'older', 'unknown']);
  });
});

describe('source catalog', () => {
  it('lists the requested sources and marks the ones without public access as manual-only', () => {
    const byKey = Object.fromEntries(SOURCE_CATALOG.map((s) => [s.key, s]));
    for (const k of ['greenhouse', 'lever', 'ashby', 'yc', 'web_search', 'career_page']) expect(byKey[k].provider).toBeDefined();
    for (const k of ['naukri', 'wellfound', 'instahyre', 'hirist']) {
      expect(byKey[k].status).toBe('manual_only');
      expect(byKey[k].provider).toBeUndefined();
    }
  });
});
