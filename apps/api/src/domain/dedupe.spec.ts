import { canonicalizeUrl, jobContentHash, jobSourceHash, normalizeCompanyName } from './dedupe';

describe('job deduplication', () => {
  const base = { companyName: 'Acme Technologies Pvt. Ltd.', title: 'Senior Backend Engineer', description: '<p>Build   APIs with Node.js</p>' };

  it('produces the same content hash for cosmetic differences', () => {
    const a = jobContentHash(base);
    const b = jobContentHash({ companyName: 'ACME', title: 'senior backend engineer ', description: 'Build APIs with Node.js!' });
    expect(a).toBe(b);
  });

  it('produces different hashes for different jobs', () => {
    expect(jobContentHash(base)).not.toBe(jobContentHash({ ...base, title: 'Senior Frontend Engineer' }));
    expect(jobContentHash(base)).not.toBe(jobContentHash({ ...base, companyName: 'Globex' }));
  });

  it('normalises company names', () => {
    expect(normalizeCompanyName('Acme, Inc.')).toBe('acme');
    expect(normalizeCompanyName('Acme Technologies Pvt Ltd')).toBe('acme');
    expect(normalizeCompanyName('Ben & Jerry')).toBe('ben and jerry');
  });

  it('canonicalises URLs by dropping tracking params and fragments', () => {
    expect(canonicalizeUrl('https://WWW.Example.com/jobs/123/?utm_source=x&gh_src=y#apply')).toBe('https://example.com/jobs/123');
    expect(canonicalizeUrl('https://example.com/jobs?id=5&utm_medium=a')).toBe('https://example.com/jobs?id=5');
    expect(canonicalizeUrl('ftp://example.com')).toBeNull();
    expect(canonicalizeUrl('not a url')).toBeNull();
  });

  it('builds source hashes from external ids or canonical URLs', () => {
    expect(jobSourceHash({ provider: 'GREENHOUSE', externalId: '42' })).toBe(jobSourceHash({ provider: 'GREENHOUSE', externalId: '42', url: 'https://x' }));
    expect(jobSourceHash({ provider: 'URL', url: 'https://example.com/a?utm_source=li' })).toBe(jobSourceHash({ provider: 'PASTE', url: 'https://www.example.com/a' }));
    expect(jobSourceHash({ provider: 'MANUAL' })).toBeNull();
  });
});
