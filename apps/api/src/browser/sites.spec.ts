import { DEFAULT_SITE_KEYS, jobLinks, SITES, sitesByKey } from './sites';

const site = (k: string) => SITES.find((s) => s.key === k)!;

describe('sites', () => {
  it('runs only the lower-risk boards by default; Naukri and Indeed must be named', () => {
    expect(DEFAULT_SITE_KEYS).toEqual(['wellfound', 'hirist', 'instahyre']);
  });

  it('rejects unknown site names with the list of known ones', () => {
    expect(() => sitesByKey(['monster'])).toThrow(/Unknown site\(s\): monster\. Known: wellfound/);
  });

  it('asks Naukri for jobs within the age window', () => {
    expect(site('naukri').searchUrls(['node.js backend developer'], 7)[0]).toBe('https://www.naukri.com/node-js-backend-developer-jobs?k=node.js%20backend%20developer&experience=3&jobAge=7');
  });

  it('keeps each job link once, without tracking parameters, up to the cap', () => {
    const hrefs = [
      'https://www.naukri.com/job-listings-backend-111?src=jobsearchDesk&sid=abc',
      'https://www.naukri.com/job-listings-backend-111?src=other',
      'https://www.naukri.com/acme-jobs-careers-1',
      'https://www.naukri.com/job-listings-backend-222',
      'https://www.naukri.com/job-listings-backend-333',
    ];
    expect(jobLinks(hrefs, site('naukri'), 2)).toEqual(['https://www.naukri.com/job-listings-backend-111', 'https://www.naukri.com/job-listings-backend-222']);
  });

  it('recognises login and security walls', () => {
    expect(site('wellfound').isWall('https://wellfound.com/login?x', 'Wellfound')).toBe(true);
    expect(site('naukri').isWall('https://www.naukri.com/jobs', 'Access Denied')).toBe(true);
    expect(site('naukri').isWall('https://www.naukri.com/node-js-jobs', 'Node Js Jobs')).toBe(false);
  });
});

describe('Indeed', () => {
  const indeed = SITES.find((s) => s.key === 'indeed')!;
  it('searches India, newest first, within the age window (Indeed allows up to 14 days)', () => {
    expect(indeed.searchUrls(['backend engineer'], 7)).toEqual(['https://in.indeed.com/jobs?q=backend%20engineer&l=India&fromage=7&sort=date']);
    expect(indeed.searchUrls(['x'], 30)[0]).toContain('fromage=14');
  });
  it('keeps one clean link per job key and drops ads and other links', () => {
    const hrefs = [
      'https://in.indeed.com/rc/clk?jk=a1b2c3d4e5f60718&bb=xyz&from=serp',
      'https://in.indeed.com/viewjob?jk=a1b2c3d4e5f60718&tk=1',
      'https://in.indeed.com/pagead/clk?mo=r&ad=-6NYlbfk',
      'https://in.indeed.com/cmp/Acme',
      'https://in.indeed.com/viewjob?jk=ffff0000aaaa1111',
    ];
    expect(jobLinks(hrefs, indeed, 10)).toEqual(['https://in.indeed.com/viewjob?jk=a1b2c3d4e5f60718', 'https://in.indeed.com/viewjob?jk=ffff0000aaaa1111']);
  });
  it('is not part of the default set (it runs only when named)', () => {
    expect(DEFAULT_SITE_KEYS).not.toContain('indeed');
  });
});
