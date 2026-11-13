import { EMPTY, Job, mergeResults, setStatus } from './store';

const job = (id: string, over: Partial<Job> = {}): Job => ({
  id, title: 'Backend Engineer', company: 'Acme', location: 'Gurugram', url: null, postedAt: '2026-11-10', source: 'GREENHOUSE',
  salaryText: null, score: 70, recommendation: 'APPLY', reasons: [], missingSkills: [], flags: [], contacts: [], ...over,
});

describe('mergeResults', () => {
  it('adds new jobs as "new" with the run time as first-seen', () => {
    const s = mergeResults(EMPTY, [job('a')], 'T1');
    expect(s.jobs.a.status).toBe('new');
    expect(s.jobs.a.firstSeenAt).toBe('T1');
    expect(s.lastRunAt).toBe('T1');
  });

  it('never repeats a job: a second search keeps one copy, its status and first-seen date', () => {
    let s = mergeResults(EMPTY, [job('a')], 'T1');
    s = setStatus(s, 'a', 'applied');
    s = mergeResults(s, [job('a', { score: 80 }), job('b')], 'T2');
    expect(Object.keys(s.jobs).sort()).toEqual(['a', 'b']);
    expect(s.jobs.a).toMatchObject({ status: 'applied', firstSeenAt: 'T1', score: 80 });
    expect(s.jobs.b.firstSeenAt).toBe('T2');
  });

  it('keeps jobs that a later search no longer returns', () => {
    const s = mergeResults(mergeResults(EMPTY, [job('a')], 'T1'), [], 'T2');
    expect(s.jobs.a).toBeDefined();
  });
});

describe('setStatus', () => {
  it('ignores unknown ids', () => {
    expect(setStatus(EMPTY, 'x', 'skipped')).toBe(EMPTY);
  });
});

describe('jobs from the shared results file (terminal runs)', () => {
  it('uses the server first-seen time for new jobs, and keeps statuses already set in this browser', () => {
    let s = mergeResults(EMPTY, [job('a')], 'T1');
    s = setStatus(s, 'a', 'skipped');
    s = mergeResults(s, [job('a', { firstSeenAt: 'T0' }), job('b', { firstSeenAt: 'T0' })], 'T2');
    expect(s.jobs.a).toMatchObject({ status: 'skipped', firstSeenAt: 'T1' });
    expect(s.jobs.b).toMatchObject({ status: 'new', firstSeenAt: 'T0' });
  });
});

describe('sourceLabel', () => {
  it('names where a job came from', async () => {
    const { sourceLabel } = await import('./store');
    expect(['GREENHOUSE', 'ASHBY', 'WORKDAY', 'WELLFOUND', 'HIRIST', 'LINKEDIN', 'INDEED', 'SOMETHING_NEW'].map(sourceLabel)).toEqual([
      'Company site', 'Company site', 'Company site', 'Wellfound', 'Hirist', 'LinkedIn', 'Indeed', 'SOMETHING_NEW',
    ]);
  });
  it('hides jobs from the removed public feeds', async () => {
    const { isKnownSource } = await import('./store');
    expect(['NAUKRI', 'WORKDAY', 'WWR', 'REMOTIVE', 'HN_HIRING'].map(isKnownSource)).toEqual([true, true, false, false, false]);
  });
});

describe('matchesFilters', () => {
  const now = new Date('2026-11-13T00:00:00Z');
  it('filters by daily picks, a picked day, minimum score and posting date; undated jobs are not treated as old', async () => {
    const { matchesFilters, NO_FILTERS } = await import('./store');
    const picked = job('p', { shownOn: '2026-11-12', score: 85, postedAt: '2026-11-11' });
    const other = job('o', { score: 65, postedAt: '2026-10-01' });
    const undated = job('u', { postedAt: null });
    expect([picked, other, undated].map((j) => matchesFilters(j, NO_FILTERS, now))).toEqual([true, true, true]);
    expect([picked, other].map((j) => matchesFilters(j, { ...NO_FILTERS, picks: 'picks' }, now))).toEqual([true, false]);
    expect(matchesFilters(picked, { ...NO_FILTERS, picks: '2026-11-13' }, now)).toBe(false);
    expect([picked, other].map((j) => matchesFilters(j, { ...NO_FILTERS, minScore: 70 }, now))).toEqual([true, false]);
    expect([picked, other, undated].map((j) => matchesFilters(j, { ...NO_FILTERS, postedWithinDays: 7 }, now))).toEqual([true, false, true]);
  });
});
