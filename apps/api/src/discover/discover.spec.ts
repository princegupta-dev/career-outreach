import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import ExcelJS from 'exceljs';
import { loadProfile } from '../domain/__fixtures__/fixtures';
import { writeDiscoverReport } from '../report';
import type { FoundJob } from '../search';
import { analyse } from './insights';
import { dailyStats, History, loadHistory, priorityOf, rejectReason, remember, sameJobKey, saveHistory, selectToday } from './select';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-discover-'));
const rules = { minScore: 70, experienceYears: 3 };
const job = (id: string, over: Partial<FoundJob> = {}): FoundJob => ({
  id, title: 'Backend Engineer', company: 'Acme', companyDomain: null, location: 'Gurugram', remote: null, url: `https://x/${id}`, postedAt: '2026-11-12T00:00:00.000Z',
  source: 'NAUKRI', salaryText: null, teamSize: null, score: 80, recommendation: 'APPLY', reasons: [], missingSkills: [], flags: [], contacts: [],
  description: 'Node.js, PostgreSQL, Redis, Kafka and microservices.', skills: ['Node.js', 'PostgreSQL', 'Redis', 'Kafka', 'Microservices'], minYears: 3, roleFamily: 'backend', seniority: 'mid', ...over,
});

describe('priorityOf', () => {
  it.each([
    ['Senior Backend Engineer', 0], ['Node.js Developer', 0], ['Platform Engineer', 0], ['Senior Backend + AI Engineer', 0], ['TypeScript Engineer', 0],
    ['Software Engineer', 1], ['SDE II', 1], ['Member of Technical Staff', 1], ['Full Stack Developer', 2],
    ['Senior React Native Developer', null], ['Data Engineer', null], ['Staff Software Engineer', null], ['Engineering Manager', null], ['QA Lead', null], ['Sales Executive', null],
  ])('%s → %s', (title, p) => {
    expect(priorityOf(title)).toBe(p);
  });
});

describe('rejectReason (quality gate: never relaxed to reach 50)', () => {
  it.each([
    [job('a'), null],
    [job('b', { score: 69 }), 'score:below-minimum'],
    [job('c', { title: 'Frontend Engineer' }), 'role:not-a-priority-role'],
    [job('d', { flags: ['location:requires-relocation'] }), 'location:not-open-to-india'],
    [job('e', { minYears: 8 }), 'experience:asks-for-much-more'],
    [job('f', { seniority: 'principal' }), 'seniority:principal'],
    [job('g', { roleFamily: 'data' }), 'role:family-data'],
    [job('h', { recommendation: 'LOW_PRIORITY' }), 'score:low-recommendation'],
  ])('%#', (j, why) => {
    expect(rejectReason(j, rules)).toBe(why);
  });
});

describe('selectToday', () => {
  it('ranks priority roles first, then score; at most the target; fewer when fewer qualify', () => {
    const jobs = [job('sw', { title: 'Software Engineer', score: 95 }), job('be', { score: 75 }), job('low', { score: 40 }), job('fs', { title: 'Full Stack Developer', company: 'B', score: 99 })];
    const s = selectToday(jobs, { jobs: {} }, rules, 50);
    expect(s.picked.map((j) => j.id)).toEqual(['be', 'sw', 'fs']);
    expect(s.qualified).toBe(3);
    expect(s.rejected).toEqual({ 'score:below-minimum': 1 });
    expect(selectToday(jobs, { jobs: {} }, rules, 2).picked).toHaveLength(2);
  });

  it('never shows a job twice: not by id, not the same job from another source, not on a later day', () => {
    const naukri = job('n1', { company: 'Acme Pvt Ltd', title: 'Sr. Backend Engineer (Node.js)' });
    const linkedin = job('l1', { source: 'LINKEDIN', company: 'Acme', title: 'Senior Backend Engineer', score: 70 });
    const day1 = selectToday([naukri, linkedin], { jobs: {} }, rules);
    expect(day1.picked.map((j) => j.id)).toEqual(['n1']); // same job on two sites: once
    const h = remember({ jobs: {} }, day1.picked, '2026-11-12');
    const day2 = selectToday([naukri, linkedin, job('new', { company: 'Other' })], h, rules);
    expect(day2.picked.map((j) => j.id)).toEqual(['new']);
    expect(day2.alreadyShown).toBe(2);
  });

  it('matches the same job across sources despite punctuation, "Sr." and company suffixes', () => {
    expect(sameJobKey('Acme Pvt Ltd', 'Sr. Backend Engineer (Node.js)')).toBe(sameJobKey('Acme', 'Senior Backend Engineer'));
    expect(sameJobKey('Acme', 'Backend Engineer')).not.toBe(sameJobKey('Acme', 'Frontend Engineer'));
  });
});

describe('history file (permanent record)', () => {
  it('saves and loads; a missing file is an empty history', () => {
    const file = path.join(tmp, 'history.json');
    expect(loadHistory(file)).toEqual({ jobs: {} });
    saveHistory(remember({ jobs: {} }, [job('a')], '2026-11-12'), file);
    expect(loadHistory(file).jobs.a).toMatchObject({ shownOn: '2026-11-12', source: 'NAUKRI', score: 80 });
  });

  it('gives daily statistics per source, newest day first', () => {
    const h: History = remember(remember({ jobs: {} }, [job('a'), job('b', { source: 'LINKEDIN', score: 70 })], '2026-11-12'), [job('c')], '2026-11-13');
    expect(dailyStats(h)).toEqual([
      { day: '2026-11-13', total: 1, bySource: { NAUKRI: 1 }, avgScore: 80 },
      { day: '2026-11-12', total: 2, bySource: { NAUKRI: 1, LINKEDIN: 1 }, avgScore: 75 },
    ]);
  });
});

describe('analyse (skill gaps)', () => {
  const profile = loadProfile();
  const resume = 'Built Node.js and PostgreSQL services with Redis caching.';

  it('counts demand per skill with percentages and your status for each', () => {
    const jobs = [job('a'), job('b', { skills: ['Node.js', 'Kafka'] }), job('c', { skills: ['Node.js', 'BullMQ'] }), job('d', { skills: ['Java'] })];
    const i = analyse(jobs, profile, resume);
    const by = Object.fromEntries(i.skills.map((s) => [s.skill, s]));
    expect(by['Node.js']).toEqual({ skill: 'Node.js', jobs: 3, percent: 75, status: 'on-resume' });
    expect(by['Kafka']).toMatchObject({ jobs: 2, percent: 50, status: 'missing' });
    expect(by['BullMQ']).toMatchObject({ status: 'not-on-resume' }); // strong in the profile, never mentioned on the resume
    expect(i.missingSkills.map((s) => s.skill)).toContain('Kafka');
    // In the profile but not in this resume text: BullMQ (strong), Java and Microservices (partial).
    expect(i.missingEvidence.map((s) => s.skill)).toEqual(expect.arrayContaining(['BullMQ', 'Java', 'Microservices']));
    expect(i.missingEvidence.map((s) => s.skill)).not.toContain('Node.js');
  });

  it('reports how often jobs ask for more years than you have', () => {
    const i = analyse([job('a', { minYears: 2 }), job('b', { minYears: 5 }), job('c', { minYears: null })], profile, resume);
    expect(i.experience).toMatchObject({ withYears: 2, aboveYours: 1, percentAboveYours: 50, yours: profile.experienceYears });
    expect(i.experience.buckets).toEqual({ '0-2 years': 1, '3-4 years': 0, '5-6 years': 1, '7+ years': 0 });
  });

  it('works out skills, years and seniority from the description for older saved jobs', () => {
    const old = job('o', { skills: undefined, minYears: undefined, seniority: undefined, title: 'Senior Backend Engineer', description: 'We need 5+ years of experience with Node.js and Kafka.' });
    const i = analyse([old], profile, resume);
    expect(i.skills.map((s) => s.skill)).toEqual(expect.arrayContaining(['Node.js', 'Kafka']));
    expect(i.experience.withYears).toBe(1);
    expect(i.seniority).toEqual({ senior: 1 });
  });
});

describe('writeDiscoverReport', () => {
  it("writes Today's jobs, Skill gaps and Experience sheets", async () => {
    const i = analyse([job('a')], loadProfile(), 'Node.js');
    const file = await writeDiscoverReport([job('a')], i, path.join(tmp, 'discover.xlsx'));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Today's jobs", 'Skill gaps', 'Experience']);
    expect(wb.getWorksheet('Skill gaps')!.getRow(2).values).toEqual(expect.arrayContaining(['Kafka', 1, 100, 'Missing']));
  });
});
