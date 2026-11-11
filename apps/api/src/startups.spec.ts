import { FetchError } from './providers/http';
import { Ats, findBoard, mentionsCompany, pickStartups, slugCandidates, YcCompany } from './startups';

const co = (over: Partial<YcCompany> = {}): YcCompany => ({
  id: 1, name: 'Acme Labs', slug: 'acme-labs', website: 'https://www.acmehq.com', team_size: 70, all_locations: 'Bengaluru, KA, India', isHiring: true, status: 'Active', ...over,
});

describe('pickStartups', () => {
  it('keeps active, hiring 50–100 person companies in India or remote', () => {
    const list = [
      co(),
      co({ id: 2, team_size: 49 }),
      co({ id: 3, team_size: 101 }),
      co({ id: 4, isHiring: false }),
      co({ id: 5, status: 'Acquired' }),
      co({ id: 6, all_locations: 'San Francisco, CA, USA' }),
      co({ id: 7, all_locations: 'Berlin', regions: ['Remote'] }),
    ];
    expect(pickStartups(list, 50, 100).map((c) => c.id)).toEqual([1, 7]);
  });
});

describe('slugCandidates', () => {
  it('tries the website label first, then the YC slug and name forms', () => {
    expect(slugCandidates(co())).toEqual(['acmehq', 'acme-labs', 'acmelabs']);
  });
});

describe('mentionsCompany', () => {
  it('matches ignoring case and punctuation, and refuses tiny names', () => {
    expect(mentionsCompany('Acme Labs', 'Join ACME-labs today')).toBe(true);
    expect(mentionsCompany('Acme Labs', 'Another company')).toBe(false);
    expect(mentionsCompany('AB', 'AB is hiring')).toBe(false);
  });
});

describe('findBoard', () => {
  const probes = (hit: Ats | null, err?: Error): Record<Ats, (slug: string) => Promise<boolean>> => {
    const p = (ats: Ats) => async (slug: string) => {
      if (err) throw err;
      return ats === hit && slug === 'acme-labs';
    };
    return { GREENHOUSE: p('GREENHOUSE'), ASHBY: p('ASHBY'), LEVER: p('LEVER') };
  };

  it('returns the first verified board', async () => {
    expect(await findBoard(co(), probes('ASHBY'))).toEqual({ ats: 'ASHBY', slug: 'acme-labs' });
  });
  it('returns null (cacheable) when every board says 404', async () => {
    expect(await findBoard(co(), probes(null, new FetchError('nope', 404)))).toBeNull();
  });
  it('returns undefined (retry later) on a network error, so it is not cached as "no board"', async () => {
    expect(await findBoard(co(), probes(null, new FetchError('timeout', 0)))).toBeUndefined();
  });
});
