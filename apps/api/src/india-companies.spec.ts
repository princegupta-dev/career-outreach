import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { INDIA_COMPANIES, indiaCompanies } from './india-companies';
import { resolveBoards, YcCompany } from './startups';

describe('India company list', () => {
  it('has unique names and https websites', () => {
    const names = INDIA_COMPANIES.map(([n]) => n.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    expect(INDIA_COMPANIES.every(([, w]) => w.startsWith('https://'))).toBe(true);
  });
  it('becomes directory entries with prefixed keys and slugs', () => {
    expect(indiaCompanies([['Urban Company', 'https://urbancompany.com']])).toEqual([{ id: 'in:urban-company', name: 'Urban Company', slug: 'urban-company', website: 'https://urbancompany.com' }]);
  });
});

describe('resolveBoards (shared by startups and the India list)', () => {
  const companies: YcCompany[] = [{ id: 'in:acme', name: 'Acme' }, { id: 'in:none', name: 'None' }, { id: 'in:flaky', name: 'Flaky' }];
  const now = new Date('2026-11-11T00:00:00Z');
  beforeEach(() => {
    process.env.STARTUP_CACHE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jh-boards-')), 'cache.json');
  });
  afterAll(() => delete process.env.STARTUP_CACHE_FILE);

  it('caches boards and "no board", but not network errors, and does not re-probe within 14 days', async () => {
    const probed: string[] = [];
    const probe = async (c: YcCompany) => (probed.push(c.name), c.name === 'Acme' ? { ats: 'LEVER' as const, slug: 'acme' } : c.name === 'None' ? null : undefined);
    const first = await resolveBoards(companies, { probe, now });
    expect([...first.boards]).toEqual([['in:acme', { ats: 'LEVER', slug: 'acme' }]]);
    expect(first.unreachable).toBe(1);
    probed.length = 0;
    await resolveBoards(companies, { probe, now: new Date('2026-11-20T00:00:00Z') });
    expect(probed).toEqual(['Flaky']); // only the one that failed is tried again
    probed.length = 0;
    await resolveBoards(companies, { probe, now: new Date('2026-12-01T00:00:00Z') });
    expect(probed.sort()).toEqual(['Acme', 'Flaky', 'None']); // after 14 days, everything is re-checked
  });
});
