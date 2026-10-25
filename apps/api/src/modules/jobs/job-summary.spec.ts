import type { MatchResult } from '../../domain/matching/scorer';
import type { JobExtraction } from '../../domain/skills/extract';
import { summarizeJob, SummaryInput, verdictFor } from './job-summary';

const breakdown = {
  total: 84,
  recommendation: 'STRONG_APPLY',
  components: [
    { key: 'skills', label: 'Skills', score: 22, max: 25, reason: '4 of 5 required skills match' },
    { key: 'salary', label: 'Salary', score: 6, max: 10, reason: 'Salary not disclosed' },
    { key: 'company', label: 'Company', score: 7, max: 10, reason: 'Company size/type unknown' },
    { key: 'role', label: 'Role', score: 19, max: 20, reason: 'Backend role' },
  ],
  skills: [
    { skill: 'Node.js', level: 'strong', required: true },
    { skill: 'TypeScript', level: 'strong', required: true },
    { skill: 'Kafka', level: 'missing', required: true },
    { skill: 'Go', level: 'missing', required: false },
    { skill: 'GraphQL', level: 'partial', required: false },
  ],
  strong: ['Node.js', 'TypeScript'],
  partial: ['GraphQL'],
  missing: ['Kafka'],
  reasons: [],
  flags: [],
} as unknown as MatchResult;

const base: SummaryInput = {
  title: 'Senior Backend Engineer',
  location: 'Bengaluru, India',
  remote: false,
  score: 84,
  recommendation: 'STRONG_APPLY',
  scoreBreakdown: breakdown,
  extracted: { minYears: 4, seniority: 'senior', workMode: 'onsite', locationRestrictions: [], visaSponsorship: 'unknown' } as unknown as JobExtraction,
  eligibility: 'ELIGIBLE',
  eligibilityFlags: [],
  salaryMin: null,
  salaryMax: null,
  postedAt: null,
  company: { size: 'UNKNOWN', teamSize: null, provenance: null },
};

describe('job summary (the answer to "should I apply?")', () => {
  it('maps the recommendation to the four verdicts', () => {
    expect([verdictFor('STRONG_APPLY'), verdictFor('APPLY'), verdictFor('CONSIDER'), verdictFor('LOW_PRIORITY'), verdictFor('SKIP'), verdictFor(null)]).toEqual([
      'STRONG_MATCH',
      'GOOD_MATCH',
      'REVIEW_MANUALLY',
      'NOT_RECOMMENDED',
      'NOT_RECOMMENDED',
      'REVIEW_MANUALLY',
    ]);
  });

  it('explains the match in one honest sentence and lists skills, never the "unknown" defaults, as reasons', () => {
    const s = summarizeJob(base);
    expect(s.verdictLabel).toBe('Strong match');
    expect(s.explanation).toBe('Strong match at 84% — 2 of 3 required skills match (Node.js, TypeScript); location: Bengaluru, India.');
    expect(s.whyMatches[0]).toBe('You already use Node.js, TypeScript.');
    expect(s.whyMatches).toEqual(expect.arrayContaining(['4 of 5 required skills match', 'Backend role']));
    expect(s.whyMatches.join(' ')).not.toMatch(/unknown|not disclosed/i);
    expect(s.skills).toEqual({ missingRequired: ['Kafka'], missingPreferred: ['Go'], partial: ['GraphQL'] });
  });

  it('marks unknown facts as unknown instead of guessing', () => {
    const s = summarizeJob(base);
    expect(s.facts.salary.known).toBe(false);
    expect(s.facts.companySize).toEqual({ known: false, label: 'Unknown' });
    expect(s.facts.experience).toMatchObject({ known: true, label: '4+ years' });
    expect(s.toVerify).toEqual(expect.arrayContaining(["Salary isn't disclosed.", 'Company size is unknown.']));
    const noYears = summarizeJob({ ...base, extracted: { ...base.extracted!, minYears: null } });
    expect(noYears.facts.experience).toEqual({ known: false, label: 'Not stated' });
    expect(noYears.toVerify).toContain("Required experience isn't stated.");
  });

  it('flags an unstated region as something to verify, and a restricted one as a warning', () => {
    const remote = summarizeJob({ ...base, location: 'Remote', remote: true, eligibility: 'UNCERTAIN', eligibilityFlags: ['location:remote-region-unstated'] });
    expect(remote.facts.location).toMatchObject({ status: 'uncertain', known: false, label: 'Remote — region not stated' });
    expect(remote.toVerify[0]).toMatch(/Location eligibility isn't stated/);
    const us = summarizeJob({ ...base, location: 'Remote - USA', remote: true });
    expect(us.facts.location.status).toBe('restricted');
    const worldwide = summarizeJob({ ...base, location: 'Remote (Worldwide)', remote: true });
    expect(worldwide.facts.location).toMatchObject({ status: 'open', known: true, label: 'Remote (Worldwide)' });
    expect(summarizeJob({ ...base, location: 'APAC', remote: true }).facts.location.label).toBe('Remote — APAC');
    const described = summarizeJob({ ...base, location: 'Remote', remote: true, extracted: { ...base.extracted!, locationRestrictions: ['US only'] } });
    expect(described.facts.location).toMatchObject({ status: 'restricted', label: 'Restricted: US only' });
  });

  it('turns the soft eligibility flags into plain sentences', () => {
    const s = summarizeJob({ ...base, eligibilityFlags: ['seniority:staff', 'stack:java', 'age:older-than-30d', 'age:unknown', 'adjacent:data engineer'] });
    const text = s.toVerify.join(' | ');
    expect(text).toMatch(/more senior level.*staff/);
    expect(text).toMatch(/different main stack.*java/);
    expect(text).toMatch(/over 30 days ago/);
    expect(text).toMatch(/posting date is unknown/);
    expect(text).toMatch(/adjacent discipline/);
  });

  it('reports company size only from a source it can name', () => {
    expect(summarizeJob({ ...base, company: { size: 'GROWTH_STARTUP', teamSize: 120, provenance: { source: 'yc-oss' } } }).facts.companySize).toEqual({ known: true, label: '~120 people', source: 'YC startup directory' });
    expect(summarizeJob({ ...base, company: { size: 'EARLY_STARTUP', teamSize: null, provenance: null } }).facts.companySize).toMatchObject({ known: true, label: 'Early-stage startup', source: 'set on the company record' });
  });

  it('copes with a job that has not been scored', () => {
    const s = summarizeJob({ ...base, score: null, recommendation: null, scoreBreakdown: null });
    expect(s.verdict).toBe('REVIEW_MANUALLY');
    expect(s.explanation).toBe('This job has not been scored yet.');
    expect(s.whyMatches).toEqual([]);
  });
});
