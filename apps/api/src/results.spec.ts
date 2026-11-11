import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EMPTY_STORE, listJobs, loadStore, mergeRun, saveRun } from './results';
import type { FoundJob } from './search';

const job = (id: string, over: Partial<FoundJob> = {}): FoundJob => ({
  id, title: 'Backend Engineer', company: 'Acme', companyDomain: null, location: 'Gurugram', remote: null, url: null, postedAt: '2026-11-10T00:00:00.000Z',
  source: 'WELLFOUND', salaryText: null, teamSize: null, score: 70, recommendation: 'APPLY', reasons: [], missingSkills: [], flags: [], contacts: [], ...over,
});

describe('mergeRun', () => {
  it('keeps each job once across runs, with its first-seen time and fresh details', () => {
    let s = mergeRun(EMPTY_STORE, { ranAt: '2026-11-10T00:00:00.000Z', jobs: [job('a', { score: 60 })] });
    s = mergeRun(s, { ranAt: '2026-11-11T00:00:00.000Z', jobs: [job('a', { score: 80 }), job('b')] });
    expect(Object.keys(s.jobs).sort()).toEqual(['a', 'b']);
    expect(s.jobs.a).toMatchObject({ score: 80, firstSeenAt: '2026-11-10T00:00:00.000Z', lastSeenAt: '2026-11-11T00:00:00.000Z' });
    expect(s.updatedAt).toBe('2026-11-11T00:00:00.000Z');
  });

  it('keeps jobs a later run did not return (e.g. a terminal run with job boards, then a quick dashboard run)', () => {
    const s = mergeRun(mergeRun(EMPTY_STORE, { ranAt: '2026-11-10T00:00:00.000Z', jobs: [job('hirist-1', { source: 'HIRIST' })] }), { ranAt: '2026-11-11T00:00:00.000Z', jobs: [] });
    expect(s.jobs['hirist-1']).toBeDefined();
  });

  it('drops jobs first seen more than 45 days ago', () => {
    const s = mergeRun(mergeRun(EMPTY_STORE, { ranAt: '2026-09-01T00:00:00.000Z', jobs: [job('old')] }), { ranAt: '2026-11-11T00:00:00.000Z', jobs: [job('new')] });
    expect(Object.keys(s.jobs)).toEqual(['new']);
  });
});

describe('listJobs', () => {
  it('lists newest postings first', () => {
    const s = mergeRun(EMPTY_STORE, { ranAt: '2026-11-11T00:00:00.000Z', jobs: [job('a', { postedAt: '2026-11-01T00:00:00.000Z' }), job('b', { postedAt: '2026-11-09T00:00:00.000Z' })] });
    expect(listJobs(s).map((j) => j.id)).toEqual(['b', 'a']);
  });
});

describe('saveRun / loadStore', () => {
  it('writes the shared file and reads it back; a missing file is an empty store', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jh-results-')), 'results.json');
    expect(loadStore(file)).toEqual(EMPTY_STORE);
    saveRun({ ranAt: '2026-11-10T00:00:00.000Z', jobs: [job('a')] }, file);
    saveRun({ ranAt: '2026-11-11T00:00:00.000Z', jobs: [job('b')] }, file);
    expect(Object.keys(loadStore(file).jobs).sort()).toEqual(['a', 'b']);
  });
});
