import { BACKEND_JD, FRONTEND_JD, JAVA_JD, loadProfile } from '../__fixtures__/fixtures';
import { extractJob } from '../skills/extract';
import { classifySkill, recommendationFor, scoreJob } from './scorer';

const profile = loadProfile();

function score(title: string, description: string, extra: Partial<Parameters<typeof scoreJob>[0]> = {}) {
  return scoreJob({ title, companyName: 'Acme', extraction: extractJob({ title, description, location: extra.location }), ...extra }, profile);
}

describe('deterministic job scoring', () => {
  it('scores a strong Node/TS backend role highly', () => {
    const r = score('Senior Backend Engineer', BACKEND_JD, { companySize: 'GROWTH_STARTUP' });
    expect(r.total).toBeGreaterThanOrEqual(80);
    expect(r.recommendation).toBe('STRONG_APPLY');
    expect(r.strong).toEqual(expect.arrayContaining(['Node.js', 'TypeScript', 'Redis', 'AWS', 'PostgreSQL']));
    expect(r.components.reduce((a, c) => a + c.max, 0)).toBe(100);
  });

  it('marks adjacent technologies as partial and unknown ones as missing', () => {
    expect(classifySkill('Kafka', profile)).toMatchObject({ level: 'partial' });
    expect(classifySkill('Kubernetes', profile)).toMatchObject({ level: 'partial', via: expect.stringContaining('Docker') });
    expect(classifySkill('Cassandra', profile)).toEqual({ level: 'missing' });
    expect(classifySkill('SQL', profile)).toMatchObject({ level: 'strong' });
  });

  it('never treats missing skills as matches', () => {
    const r = score('Senior Java Engineer', JAVA_JD, { location: 'Berlin, Germany' });
    expect(r.missing).toEqual(expect.arrayContaining(['Java', 'Spring', 'Cassandra']));
    expect(r.strong).not.toContain('Java');
    expect(['SKIP', 'LOW_PRIORITY']).toContain(r.recommendation);
  });

  it('skips frontend roles', () => {
    const r = score('Senior Frontend Engineer', FRONTEND_JD);
    expect(r.recommendation).toBe('SKIP');
  });

  it('honours the avoid list', () => {
    const avoid = { ...profile, avoid_companies: ['Acme'] };
    const r = scoreJob({ title: 'Senior Backend Engineer', companyName: 'Acme', extraction: extractJob({ title: 'Senior Backend Engineer', description: BACKEND_JD }) }, avoid);
    expect(r.recommendation).toBe('SKIP');
  });

  it('penalises experience gaps', () => {
    const r = score('Senior Backend Engineer', BACKEND_JD.replace('3+ years', '8+ years'));
    const exp = r.components.find((c) => c.key === 'experience')!;
    expect(exp.score).toBeLessThanOrEqual(1);
  });

  it('is deterministic', () => {
    expect(score('Senior Backend Engineer', BACKEND_JD)).toEqual(score('Senior Backend Engineer', BACKEND_JD));
  });

  it('maps totals to recommendations', () => {
    expect(recommendationFor(91)).toBe('STRONG_APPLY');
    expect(recommendationFor(70)).toBe('APPLY');
    expect(recommendationFor(56)).toBe('CONSIDER');
    expect(recommendationFor(41)).toBe('LOW_PRIORITY');
    expect(recommendationFor(10)).toBe('SKIP');
  });
});

describe('seniority + company-name edge cases (found on live data)', () => {
  it('does not treat a new-grad role as a senior target-role match', () => {
    const r = score('Software Engineer, New Grad (2027)', BACKEND_JD);
    expect(r.components.find((c) => c.key === 'role')!.reason).not.toMatch(/matches target role/);
    expect(r.components.find((c) => c.key === 'seniority')!.score).toBeLessThanOrEqual(3);
  });
  it('ignores a "skill" that is just the company name (e.g. Sentry)', () => {
    const ex = extractJob({ title: 'Senior Backend Engineer', description: `${BACKEND_JD}\nAt Sentry we use Sentry to monitor Sentry.`, companyName: 'Sentry' });
    expect([...ex.requiredSkills, ...ex.preferredSkills]).not.toContain('Sentry');
  });
});
