import * as fs from 'fs';
import * as path from 'path';
import { BACKEND_JD, loadProfile } from '../__fixtures__/fixtures';
import { extractJob } from '../skills/extract';
import { findSkills } from '../skills/taxonomy';
import { resumeFromProfile } from './from-profile';
import { parseResumeText } from './parse-text';
import { resumeGaps, tailorResume } from './tailor';
import { checkBulletRewrite } from './truth-guard';

const profile = loadProfile();
const master = resumeFromProfile(profile);
const ex = extractJob({ title: 'Senior Backend Engineer', description: BACKEND_JD });

describe('master resume from profile', () => {
  it('only contains skills from the profile', () => {
    const resumeSkills = master.skills.flatMap((g) => g.items);
    for (const s of resumeSkills) expect(profile.strongSkills).toContain(s);
    const bulletSkills = master.experience.flatMap((e) => e.bullets.flatMap((b) => [...findSkills(b.text).keys()]));
    const allowed = new Set([...profile.strongSkills, 'SQL', 'Caching', 'Queue Systems', 'Loyalty Platforms', 'E-commerce', 'Observability']);
    for (const s of bulletSkills) expect(allowed.has(s)).toBe(true);
  });

  it('does not invent an employer', () => {
    expect(master.experience[0].company).toBe(profile.current_company);
  });

  it('contains no metrics', () => {
    const text = JSON.stringify(master.experience);
    expect(text).not.toMatch(/\d+\s?%|\d+x\b/);
  });
});

describe('resume tailoring (relevant experience selection)', () => {
  const result = tailorResume(master, ex, profile, 'Senior Backend Engineer');

  it('puts the most JD-relevant bullets first', () => {
    const first = result.data.experience[0].bullets[0].text;
    expect(first).toMatch(/Node\.js|Redis|PostgreSQL|AWS/);
  });

  it('never adds skills that are not in the master resume', () => {
    const before = new Set(master.skills.flatMap((g) => g.items));
    const after = result.data.skills.flatMap((g) => g.items);
    for (const s of after) expect(before.has(s)).toBe(true);
    expect(after.length).toBe(before.size);
  });

  it('reports JD gaps instead of faking them', () => {
    expect(result.gaps).toEqual(expect.arrayContaining(['Kafka', 'Kubernetes']));
    expect(result.data.skills.flatMap((g) => g.items)).not.toContain('Kafka');
  });

  it('keeps every bullet a verbatim copy of a master bullet', () => {
    const masterTexts = new Set(master.experience.flatMap((e) => e.bullets.map((b) => b.text)));
    for (const b of result.data.experience.flatMap((e) => e.bullets)) expect(masterTexts.has(b.text)).toBe(true);
  });

  it('records what changed', () => {
    expect(result.changes.map((c) => c.section)).toEqual(expect.arrayContaining(['skills', 'summary']));
  });

  it('is deterministic', () => {
    expect(tailorResume(master, ex, profile, 'Senior Backend Engineer')).toEqual(result);
  });
});

describe('bullet rewrite truth guard', () => {
  const original = 'Worked with Redis for caching and BullMQ for background jobs.';
  it('accepts a faithful rephrase', () => {
    expect(checkBulletRewrite(original, 'Used Redis caching and BullMQ queues for background processing.', []).ok).toBe(true);
  });
  it('rejects introduced technologies', () => {
    const r = checkBulletRewrite(original, 'Worked with Redis, Kafka and BullMQ for background jobs.', []);
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toMatch(/Kafka/);
  });
  it('rejects invented metrics', () => {
    expect(checkBulletRewrite(original, 'Cut latency by 40% using Redis caching and BullMQ.', []).ok).toBe(false);
  });
  it('rejects upgraded responsibility', () => {
    expect(checkBulletRewrite(original, 'Led the Redis caching and BullMQ background job architecture.', []).ok).toBe(false);
  });
});

describe('resume text import', () => {
  it('parses sections without inventing data', () => {
    const text = `Prince Gupta
prince@example.com | linkedin.com/in/prince

Experience
Senior Software Engineer at Example Corp
Jan 2023 - Present
• Built REST APIs in Node.js and TypeScript
• Worked with Redis and BullMQ

Education
BTech Computer Science, Some Institute of Technology 2023

Skills
Node.js, TypeScript, Redis, MySQL`;
    const r = parseResumeText(text);
    expect(r.basics.name).toBe('Prince Gupta');
    expect(r.basics.email).toBe('prince@example.com');
    expect(r.experience[0]).toMatchObject({ title: 'Senior Software Engineer', company: 'Example Corp', current: true });
    expect(r.experience[0].bullets).toHaveLength(2);
    expect(r.skills.flatMap((g) => g.items)).toEqual(expect.arrayContaining(['Node.js', 'TypeScript', 'Redis', 'MySQL']));
    expect(r.education[0].year).toBe('2023');
  });
});


describe('resumeGaps (what the job asks for that is not on the resume)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { resumeBodyText } = require('../latex/latex') as typeof import('../latex/latex');
  const text = resumeBodyText(fs.readFileSync(path.resolve(__dirname, '../../../../../candidate/resume.example.tex'), 'utf8')); // body only: the header's "GitHub" link label is not a skill
  const weights = (skills: string[]) => new Map(skills.map((s) => [s, 2]));

  it('never reports a skill that is on the resume — checked against the real resume text', () => {
    // React.js, Python, MongoDB, Redis, Docker and Kubernetes are all written on the resume.
    expect(resumeGaps(text, weights(['React', 'Python', 'MongoDB', 'Redis', 'Docker', 'Kubernetes', 'TypeScript', 'PostgreSQL']))).toEqual([]);
  });

  it('reports what really is missing', () => {
    const gaps = resumeGaps(text, weights(['Django', 'Git', 'Elasticsearch', 'Python', 'React']));
    expect(gaps).toEqual(expect.arrayContaining(['Django', 'Git', 'Elasticsearch']));
    expect(gaps).not.toContain('Python');
    expect(gaps).not.toContain('React');
  });
});
