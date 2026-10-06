import { BACKEND_JD, JAVA_JD } from '../__fixtures__/fixtures';
import {
  detectRoleFamily,
  detectSeniority,
  detectWorkMode,
  extractJob,
  extractYears,
  parseSalary,
  salaryInLpa,
  splitRequiredPreferred,
} from './extract';
import { canonicalizeSkill, findSkills } from './taxonomy';

describe('skill taxonomy', () => {
  it('matches aliases on token boundaries', () => {
    const found = findSkills('We use Node.js, nodejs and TS with Postgres; JavaScript too.');
    expect(found.get('Node.js')).toBe(2);
    expect(found.has('TypeScript')).toBe(true);
    expect(found.has('PostgreSQL')).toBe(true);
    expect(found.has('JavaScript')).toBe(true);
    expect(found.has('Java')).toBe(false);
  });

  it('does not treat the English word "rest" or "go to" as skills', () => {
    const found = findSkills('The rest of the team will go to the office. Let us go ahead.');
    expect(found.has('REST APIs')).toBe(false);
    expect(found.has('Go')).toBe(false);
    expect(findSkills('Backend in Go and Golang').has('Go')).toBe(true);
    expect(findSkills('Build REST APIs').has('REST APIs')).toBe(true);
  });

  it('canonicalizes profile skill names', () => {
    expect(canonicalizeSkill('Postgres')).toBe('PostgreSQL');
    expect(canonicalizeSkill('REST APIs')).toBe('REST APIs');
    expect(canonicalizeSkill('Something Unknown')).toBe('Something Unknown');
  });
});

describe('JD extraction', () => {
  it('splits required vs nice-to-have skills', () => {
    const { required, preferred } = splitRequiredPreferred(BACKEND_JD);
    expect([...required.keys()]).toEqual(expect.arrayContaining(['Node.js', 'TypeScript', 'PostgreSQL', 'Redis', 'AWS']));
    expect([...preferred.keys()]).toEqual(expect.arrayContaining(['Kafka', 'Kubernetes', 'GraphQL']));
    expect(preferred.has('Node.js')).toBe(false);
  });

  it('extracts years of experience', () => {
    expect(extractYears('3+ years of experience building backend systems')).toEqual({ min: 3, max: null });
    expect(extractYears('3-5 years of professional experience; 2+ years experience with Go')).toEqual({ min: 3, max: 5 });
    expect(extractYears('Minimum 4 years in backend')).toEqual({ min: 4, max: null });
    expect(extractYears('No years mentioned')).toEqual({ min: null, max: null });
  });

  it('detects seniority from the title', () => {
    expect(detectSeniority('Senior Backend Engineer')).toBe('senior');
    expect(detectSeniority('Sr. Software Engineer')).toBe('senior');
    expect(detectSeniority('Staff Engineer')).toBe('staff');
    expect(detectSeniority('Engineering Manager, Platform')).toBe('manager');
    expect(detectSeniority('Software Engineer II')).toBe('mid');
    expect(detectSeniority('Backend Intern')).toBe('intern');
  });

  it('detects work mode', () => {
    expect(detectWorkMode('This is a fully remote role')).toBe('remote');
    expect(detectWorkMode('Hybrid, 3 days in office')).toBe('hybrid');
    expect(detectWorkMode('This role is not remote. Work from office.')).toBe('onsite');
  });

  it('parses salary formats', () => {
    expect(parseSalary('Compensation: ₹35-45 LPA')).toMatchObject({ min: 3_500_000, max: 4_500_000, currency: 'INR' });
    expect(parseSalary('$150k - $180k per year')).toMatchObject({ min: 150_000, max: 180_000, currency: 'USD', period: 'year' });
    expect(parseSalary('€80,000 – €95,000')).toMatchObject({ min: 80_000, max: 95_000, currency: 'EUR' });
    expect(parseSalary('competitive salary')).toBeNull();
    expect(salaryInLpa(parseSalary('30 LPA'))).toEqual({ min: 30, max: 30 });
  });

  it('classifies role families', () => {
    expect(detectRoleFamily('Senior Backend Engineer')).toBe('backend');
    expect(detectRoleFamily('Node.js Developer')).toBe('backend');
    expect(detectRoleFamily('Senior Frontend Engineer')).toBe('frontend');
    expect(detectRoleFamily('Platform Engineer')).toBe('platform');
    expect(detectRoleFamily('Senior Software Engineer, AI Platform')).toBe('ai_backend');
    expect(detectRoleFamily('Technical Recruiter')).toBe('non_engineering');
  });

  it('builds a full extraction', () => {
    const ex = extractJob({ title: 'Senior Backend Engineer', description: BACKEND_JD });
    expect(ex.minYears).toBe(3);
    expect(ex.workMode).toBe('remote');
    expect(ex.salary?.currency).toBe('INR');
    expect(ex.roleFamily).toBe('backend');
    expect(ex.seniority).toBe('senior');

    const java = extractJob({ title: 'Senior Java Engineer', description: JAVA_JD, location: 'Berlin' });
    expect(java.locationRestrictions).toContain('Must be located in the EU');
    expect(java.visaSponsorship).toBe('no');
  });
});
