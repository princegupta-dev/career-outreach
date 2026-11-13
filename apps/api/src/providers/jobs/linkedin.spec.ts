import { criteriaFor, loadProfile } from '../../search';
import { httpRetry } from '../http';
import { extractEmails } from './emails';
import { LinkedInProvider, parseLinkedInDetail, parseLinkedInList } from './linkedin';

// Shapes copied from LinkedIn's public job pages (Nov 2026), trimmed.
const card = (id: string, title: string, company = 'Delta6Labs', loc = 'Noida, Uttar Pradesh, India', date = '2026-11-10') => `
  <li><div class="base-card base-search-card job-search-card" data-entity-urn="urn:li:jobPosting:${id}">
    <a class="base-card__full-link" href="https://in.linkedin.com/jobs/view/x-${id}?trk=public_jobs"></a>
    <h3 class="base-search-card__title">${title}</h3><h4 class="base-search-card__subtitle"><a>${company}</a></h4>
    <span class="job-search-card__location">${loc}</span><time class="job-search-card__listdate" datetime="${date}">1 day ago</time>
  </div></li>`;
const detail = (desc: string, poster = '') => `
  <div class="show-more-less-html__markup"><p>${desc}</p></div>
  <ul><li class="description__job-criteria-item"><h3 class="description__job-criteria-subheader">Seniority level</h3><span class="description__job-criteria-text">Mid-Senior level</span></li>
  <li class="description__job-criteria-item"><h3 class="description__job-criteria-subheader">Employment type</h3><span class="description__job-criteria-text">Full-time</span></li></ul>${poster}`;

describe('LinkedIn public pages', () => {
  it('reads job cards (id, title, company, location, date, clean link)', () => {
    expect(parseLinkedInList(card('4489453531', 'Senior Backend Engineer') + card('4489453531', 'dup') + '<li><div class="base-card">no id</div></li>')).toEqual([
      { id: '4489453531', title: 'Senior Backend Engineer', company: 'Delta6Labs', location: 'Noida, Uttar Pradesh, India', postedAt: new Date('2026-11-10'), url: 'https://www.linkedin.com/jobs/view/4489453531' },
    ]);
  });

  it('reads the description, criteria and the person who posted the job', () => {
    const d = parseLinkedInDetail(detail('Node.js APIs. Send CV to <b>hr@delta6labs.com</b>', '<div class="message-the-recruiter"><a class="base-card__full-link" href="https://in.linkedin.com/in/jane-doe?trk=x"></a><h3 class="base-main-card__title">Jane Doe</h3><h4 class="base-main-card__subtitle">Talent Acquisition at Delta6Labs</h4></div>'));
    expect(d.description).toBe('Node.js APIs. Send CV to hr@delta6labs.com');
    expect(d.criteria).toEqual({ 'Seniority level': 'Mid-Senior level', 'Employment type': 'Full-time' });
    expect(d.poster).toEqual({ name: 'Jane Doe', url: 'https://in.linkedin.com/in/jane-doe', headline: 'Talent Acquisition at Delta6Labs' });
  });
});

describe('extractEmails', () => {
  it('keeps published emails and drops placeholders, no-reply and images', () => {
    expect(extractEmails('Mail hr@acme.in, or careers@acme.co.in. Not noreply@acme.in, you@example.com or logo@2x.png')).toEqual(['hr@acme.in', 'careers@acme.co.in']);
  });
});

describe('LinkedInProvider', () => {
  const criteria = criteriaFor(loadProfile(), 7);
  const html = (b: string, status = 200) => new Response(b, { status, headers: { 'content-type': 'text/html' } });
  const urlOf = (i: string | URL | Request) => (typeof i === 'string' ? i : i instanceof URL ? i.toString() : i.url);
  beforeEach(() => (httpRetry.baseDelayMs = 1));
  afterEach(() => {
    jest.restoreAllMocks();
    httpRetry.baseDelayMs = 700;
  });

  it('searches the last N days, reads job pages, and turns published emails and the poster into contacts', async () => {
    const seen: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (i) => {
      const u = urlOf(i);
      seen.push(u);
      if (u.includes('/seeMoreJobPostings/')) return html(u.includes('start=0') ? card('1', 'Senior Backend Engineer') + card('2', 'Frontend Developer') : '');
      return html(detail('We build Node.js and PostgreSQL APIs on AWS for payments. Apply at jobs@delta6labs.com today.', '<div class="message-the-recruiter"><a href="https://in.linkedin.com/in/jane"></a><h3 class="base-main-card__title">Jane</h3></div>'));
    });
    const out = await new LinkedInProvider().searchJobs(criteria, { keywords: ['backend engineer'], delayMs: 0 });
    expect(seen[0]).toContain('f_TPR=r604800'); // 7 days in seconds
    expect(seen.filter((u) => u.includes('/jobPosting/'))).toEqual(['https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/1']); // frontend filtered before any detail request
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ provider: 'LINKEDIN', title: 'Senior Backend Engineer', companyName: 'Delta6Labs', employmentType: 'Full-time', url: 'https://www.linkedin.com/jobs/view/1' });
    expect(out[0].contacts).toEqual([
      expect.objectContaining({ email: 'jobs@delta6labs.com', source: 'linkedin-description' }),
      expect.objectContaining({ name: 'Jane', linkedinUrl: 'https://in.linkedin.com/in/jane', source: 'linkedin-job-poster' }),
    ]);
  });

  it('stops early when LinkedIn asks to slow down', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async () => html('', 429));
    const stats = { fetched: 0, warnings: [] as string[] };
    expect(await new LinkedInProvider().searchJobs({ ...criteria, stats }, { keywords: ['x'], delayMs: 0 })).toEqual([]);
    expect(stats.warnings).toEqual([expect.stringMatching(/slow down \(HTTP 429\)/)]);
  });
});
