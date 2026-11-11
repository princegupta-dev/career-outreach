import { parseJobPostings } from './ld-json';

const now = new Date('2026-11-11T00:00:00Z');
const posting = (over: Record<string, unknown> = {}) => ({
  '@context': 'https://schema.org',
  '@type': 'JobPosting',
  title: 'Senior Backend Engineer (Node.js)',
  description: '<p>Build APIs with <b>Node.js</b>, PostgreSQL and Redis.</p>',
  datePosted: '2026-11-09',
  validThrough: '2026-12-31',
  employmentType: 'FULL_TIME',
  hiringOrganization: { '@type': 'Organization', name: 'Acme', sameAs: 'https://acme.in' },
  jobLocation: { '@type': 'Place', address: { addressLocality: 'Gurugram', addressRegion: 'Haryana', addressCountry: 'IN' } },
  baseSalary: { '@type': 'MonetaryAmount', currency: 'INR', value: { minValue: 1800000, maxValue: 2600000, unitText: 'YEAR' } },
  identifier: { '@type': 'PropertyValue', name: 'Acme', value: 'JD-42' },
  url: 'https://www.naukri.com/job-listings-senior-backend-acme-42',
  ...over,
});

describe('parseJobPostings', () => {
  it('maps a schema.org JobPosting to a posting', () => {
    const [j] = parseJobPostings([JSON.stringify(posting())], 'NAUKRI', 'https://page', now);
    expect(j).toMatchObject({
      provider: 'NAUKRI',
      externalId: 'JD-42',
      title: 'Senior Backend Engineer (Node.js)',
      companyName: 'Acme',
      companyWebsite: 'https://acme.in',
      location: 'Gurugram, Haryana, IN',
      employmentType: 'FULL_TIME',
      salaryText: 'INR 1800000–2600000 year',
      url: 'https://www.naukri.com/job-listings-senior-backend-acme-42',
    });
    expect(j.description).toContain('Build APIs with Node.js');
    expect(j.description).not.toContain('<b>');
    expect(j.postedAt?.toISOString().slice(0, 10)).toBe('2026-11-09');
  });

  it('reads arrays and @graph, and ignores other types and broken JSON', () => {
    const scripts = ['{not json', JSON.stringify([{ '@type': 'Organization', name: 'X' }, posting({ title: 'A' })]), JSON.stringify({ '@graph': [posting({ title: 'B' })] })];
    expect(parseJobPostings(scripts, 'HIRIST', 'https://page', now).map((j) => j.title)).toEqual(['A', 'B']);
  });

  it('marks remote jobs and falls back to the page URL', () => {
    const [j] = parseJobPostings([JSON.stringify(posting({ jobLocationType: 'TELECOMMUTE', jobLocation: undefined, url: undefined }))], 'WELLFOUND', 'https://wellfound.com/jobs/1', now);
    expect(j.remote).toBe(true);
    expect(j.location).toBe('Remote');
    expect(j.url).toBe('https://wellfound.com/jobs/1');
  });

  it('drops expired postings and ones without a title or company', () => {
    const scripts = [posting({ validThrough: '2026-11-01' }), posting({ title: '' }), posting({ hiringOrganization: undefined })].map((p) => JSON.stringify(p));
    expect(parseJobPostings(scripts, 'NAUKRI', 'https://page', now)).toEqual([]);
  });
});
