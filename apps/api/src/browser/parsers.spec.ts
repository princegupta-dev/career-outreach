import { parseHiristItemList, parseHiristSearch, parseNaukriSearch, parseWellfoundSearch, relativePosted, wellfoundTeamSize } from './parsers';
import { SITES } from './sites';

const now = new Date('2026-11-11T12:00:00Z');

describe('parseWellfoundSearch', () => {
  const data = {
    'StartupResult:1': { name: 'cardboard.ai', slug: 'cardboard-ai', companySize: 'SIZE_51_200', highlightedJobListings: [{ __ref: 'JobListingSearchResult:42' }, { __ref: 'JobListingSearchResult:missing' }] },
    'JobListingSearchResult:42': {
      id: '42', slug: 'backend-engineer', title: 'Backend Engineer', description: '<p>Node.js and <b>PostgreSQL</b> APIs.</p>',
      liveStartAt: 1_762_800_000, locationNames: ['Bengaluru'], remote: true, acceptedRemoteLocationNames: ['India'],
      remoteConfig: { kind: 'REMOTE' }, yearsExperienceMin: 3, yearsExperienceMax: 5, jobType: 'full-time', compensation: '₹20L – ₹30L',
    },
    'Badge:X': { name: 'ignored' },
  };
  const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { apolloState: { data } } } })}</script></html>`;

  it('reads each startup’s jobs from the page data', () => {
    const [j, ...rest] = parseWellfoundSearch(html);
    expect(rest).toEqual([]);
    expect(j).toMatchObject({
      provider: 'WELLFOUND', externalId: '42', url: 'https://wellfound.com/jobs/42-backend-engineer', title: 'Backend Engineer',
      companyName: 'cardboard.ai', location: 'Bengaluru; Remote (India)', remote: true, employmentType: 'full-time', salaryText: '₹20L – ₹30L',
      companyMeta: { teamSize: 200, careerUrl: 'https://wellfound.com/company/cardboard-ai' },
    });
    expect(j.description).toBe('Node.js and PostgreSQL APIs.\n\nExperience: 3–5 years');
    expect(j.postedAt).toEqual(new Date(1_762_800_000 * 1000));
  });

  it('returns nothing for a page without data', () => {
    expect(parseWellfoundSearch('<html><title>Just a moment...</title></html>')).toEqual([]);
  });

  it('maps size bands to their upper bound', () => {
    expect(wellfoundTeamSize('SIZE_11_50')).toBe(50);
    expect(wellfoundTeamSize('SIZE_10000_PLUS')).toBe(10_000);
    expect(wellfoundTeamSize(undefined)).toBeNull();
  });
});

describe('parseHiristSearch', () => {
  const card = (href: string, heading: string, extra = '') => `
    <div class="MuiCard-root joblist-card-v2"><a href="${href}">
      <p data-testid="job_title">${heading}<span aria-label="Save Job"></span></p>
      <span data-testid="job_experience">2 - 7 yrs</span><p data-testid="job_location">Gurgaon/Gurugram</p>
      <span data-testid="job_tag_0"><span>Node.js</span></span><span data-testid="job_tag_1"><span>Redis</span></span>
      ${extra}<span data-testid="date_posted">Posted 1 week ago</span></a></div>`;
  const html = `<div>${card('/j/greyorange-senior-backend-1681825?ref=kp&jobPos=2', 'GreyOrange - Senior Software Developer II - Backend')}${card('/j/x-1', '')}</div>`;

  it('reads title, company, location, skills and posted date from each card', () => {
    const jobs = parseHiristSearch(html, now);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      provider: 'HIRIST', externalId: '1681825', url: 'https://www.hirist.tech/j/greyorange-senior-backend-1681825',
      title: 'Senior Software Developer II - Backend', companyName: 'GreyOrange', location: 'Gurgaon/Gurugram', flags: ['source:card-only'],
    });
    expect(jobs[0].description).toContain('Skills: Node.js, Redis.');
    expect(jobs[0].description).toContain('Experience: 2 - 7 yrs.');
    expect(jobs[0].postedAt?.toISOString().slice(0, 10)).toBe('2026-11-04');
  });
});

describe('relativePosted', () => {
  it.each([
    ['Posted today', '2026-11-11'],
    ['Posted 5 hours ago', '2026-11-11'],
    ['Posted yesterday', '2026-11-10'],
    ['Posted 3 days ago', '2026-11-08'],
    ['Posted 2 weeks ago', '2026-10-28'],
    ['Posted 1 month ago', '2026-10-12'],
    ['Posted 30+ days ago', '2026-10-12'],
  ])('%s → %s', (text, day) => {
    expect(relativePosted(text, now)?.toISOString().slice(0, 10)).toBe(day);
  });
  it('returns null for text it does not understand', () => {
    expect(relativePosted('Hot job', now)).toBeNull();
  });
});

describe('parseHiristItemList (fallback when cards do not render)', () => {
  const list = (items: unknown[]) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'ItemList', itemListElement: items })}</script>`;
  const items = [
    { '@type': 'ListItem', name: 'GreyOrange - Senior Software Developer II - Backend', url: 'https://www.hirist.tech/j/greyorange-senior-1681825?ref=x' },
    { '@type': 'ListItem', name: 'Not a job', url: 'https://www.hirist.tech/k/node-js-jobs' },
  ];

  it('reads company, role and link, and flags the job as list-only', () => {
    expect(parseHiristItemList(list(items))).toEqual([
      expect.objectContaining({ externalId: '1681825', url: 'https://www.hirist.tech/j/greyorange-senior-1681825', companyName: 'GreyOrange', title: 'Senior Software Developer II - Backend', postedAt: null, flags: ['source:list-only'] }),
    ]);
  });

  it('is used by the Hirist site only when no cards rendered', () => {
    const hirist = SITES.find((x) => x.key === 'hirist')!;
    const card = '<div class="joblist-card-v2"><a href="/j/acme-backend-7"><p data-testid="job_title">Acme - Backend Engineer</p></a></div>';
    expect(hirist.parseSearch!(list(items), now).map((j) => j.flags)).toEqual([['source:list-only']]);
    expect(hirist.parseSearch!(list(items) + card, now).map((j) => j.title)).toEqual(['Backend Engineer']);
  });

  it('returns nothing for an empty list (Hirist sometimes sends one)', () => {
    expect(parseHiristItemList(list([]))).toEqual([]);
  });
});

describe('sites that need a visible window', () => {
  it('Instahyre, Naukri and Indeed (their bot checks block headless Chrome)', () => {
    expect(SITES.filter((x) => x.headed).map((x) => x.key)).toEqual(['instahyre', 'naukri', 'indeed']);
  });
});

describe('parseNaukriSearch (Naukri search API response)', () => {
  const body = JSON.stringify({
    noOfJobs: 2,
    jobDetails: [
      {
        jobId: '261106001', title: 'Back End Developer (Node.js)', companyName: 'Dev Solutions', jdURL: '/job-listings-back-end-developer-261106001',
        createdDate: '1794400000000', placeholders: [{ type: 'experience', label: '3-6 Yrs' }, { type: 'salary', label: '12-22 Lacs PA' }, { type: 'location', label: 'Gurugram' }],
        tagsAndSkills: 'Node.js,TypeScript,Redis', jobDescription: '<p>Build <b>Node.js</b> APIs.</p>', companyApplyJob: false, questionnaireIdPresent: true,
      },
      { jobId: '2', title: 'Software Developer', companyName: 'Cars24', jdURL: '/job-listings-2', placeholders: [{ type: 'salary', label: 'Not disclosed' }], companyApplyJob: true },
      { jobId: '3', title: '', companyName: 'X', jdURL: '/job-listings-3' },
    ],
  });

  it('reads each job, with what Apply will do', () => {
    const [a, b, ...rest] = parseNaukriSearch(body);
    expect(rest).toEqual([]);
    expect(a).toMatchObject({
      provider: 'NAUKRI', externalId: '261106001', url: 'https://www.naukri.com/job-listings-back-end-developer-261106001', title: 'Back End Developer (Node.js)',
      companyName: 'Dev Solutions', location: 'Gurugram', salaryText: '12-22 Lacs PA', flags: ['apply:questions'],
    });
    expect(a.description).toBe('Build Node.js APIs.\nSkills: Node.js, TypeScript, Redis.\nExperience: 3-6 Yrs.');
    expect(a.postedAt).toEqual(new Date(1794400000000));
    expect(b).toMatchObject({ salaryText: null, flags: ['apply:company-site'], postedAt: null });
  });

  it('returns nothing for a body that is not JSON', () => {
    expect(parseNaukriSearch('<html>Access Denied</html>')).toEqual([]);
  });
});
