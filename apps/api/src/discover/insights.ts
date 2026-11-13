import * as fs from 'fs';
import * as path from 'path';
import type { CandidateProfile } from '../domain/profile/profile';
import { extractJob } from '../domain/skills/extract';
import { findSkills } from '../domain/skills/taxonomy';
import type { FoundJob } from '../search';

/**
 * Profile gap analysis over the qualified job descriptions: which skills companies ask for, how often, and where you
 * stand on each — on your resume, in your profile but missing from the resume (missing evidence), partial, or missing.
 * Plus how often jobs ask for more years than you have, and the seniority they target.
 */
export type SkillStatus = 'on-resume' | 'not-on-resume' | 'partial' | 'missing';

export interface SkillDemand {
  skill: string;
  jobs: number;
  percent: number;
  status: SkillStatus;
}

export interface Insights {
  generatedAt: string;
  jobsAnalysed: number;
  skills: SkillDemand[];
  /** Skills in demand that you have, but your resume never mentions: add evidence for these first. */
  missingEvidence: SkillDemand[];
  /** In-demand skills you do not have yet, most demanded first. */
  missingSkills: SkillDemand[];
  experience: { withYears: number; aboveYours: number; percentAboveYours: number; buckets: Record<string, number>; yours: number };
  seniority: Record<string, number>;
}

const pct = (n: number, of: number) => (of ? Math.round((n / of) * 1000) / 10 : 0);

/** Skills mentioned in a job: from the saved extraction, or found in the description for older saved jobs. */
export function skillsOf(j: FoundJob): string[] {
  return j.skills?.length ? j.skills : [...findSkills(`${j.title}\n${j.description ?? ''}`).keys()];
}

/** Older saved jobs lack the extracted fields: work them out from the description (same extractor as new jobs). */
function withExtraction(j: FoundJob): FoundJob {
  if (j.skills && j.minYears !== undefined && j.seniority) return j;
  const x = extractJob({ title: j.title, description: j.description ?? '', location: j.location, companyName: j.company });
  return { ...j, skills: j.skills?.length ? j.skills : [...new Set([...x.requiredSkills, ...x.preferredSkills])], minYears: j.minYears ?? x.minYears, seniority: j.seniority ?? x.seniority };
}

export function analyse(input: FoundJob[], profile: CandidateProfile, resumeText: string, now = new Date()): Insights {
  const jobs = input.map(withExtraction);
  const strong = new Set(profile.strongSkills.map((s) => s.toLowerCase()));
  const partial = new Set(profile.partialSkills.map((s) => s.toLowerCase()));
  const onResume = new Set([...findSkills(resumeText).keys()].map((s) => s.toLowerCase()));
  const count = new Map<string, number>();
  for (const j of jobs) for (const s of new Set(skillsOf(j))) count.set(s, (count.get(s) ?? 0) + 1);

  const statusOf = (skill: string): SkillStatus => {
    const k = skill.toLowerCase();
    if (strong.has(k)) return onResume.has(k) ? 'on-resume' : 'not-on-resume';
    if (partial.has(k)) return onResume.has(k) ? 'partial' : 'not-on-resume';
    return 'missing';
  };
  const skills = [...count.entries()]
    .map(([skill, n]) => ({ skill, jobs: n, percent: pct(n, jobs.length), status: statusOf(skill) }))
    .sort((a, b) => b.jobs - a.jobs || a.skill.localeCompare(b.skill));

  const yours = profile.experienceYears;
  const withYears = jobs.filter((j) => j.minYears != null);
  const buckets: Record<string, number> = { '0-2 years': 0, '3-4 years': 0, '5-6 years': 0, '7+ years': 0 };
  for (const j of withYears) {
    const y = j.minYears!;
    buckets[y <= 2 ? '0-2 years' : y <= 4 ? '3-4 years' : y <= 6 ? '5-6 years' : '7+ years']++;
  }
  const above = withYears.filter((j) => j.minYears! > yours).length;
  const seniority: Record<string, number> = {};
  for (const j of jobs) seniority[j.seniority ?? 'unknown'] = (seniority[j.seniority ?? 'unknown'] ?? 0) + 1;

  return {
    generatedAt: now.toISOString(),
    jobsAnalysed: jobs.length,
    skills,
    missingEvidence: skills.filter((s) => s.status === 'not-on-resume'),
    missingSkills: skills.filter((s) => s.status === 'missing'),
    experience: { withYears: withYears.length, aboveYours: above, percentAboveYours: pct(above, withYears.length), buckets, yours },
    seniority,
  };
}

export const insightsFile = () => process.env.JOB_HUNTER_INSIGHTS ?? path.resolve(__dirname, '../../.cache/insights.json');
/** Your current resume as plain text (from your PDF); the older LaTeX master is the fallback. */
export const RESUME_TEXT_FILE = path.resolve(__dirname, '../../../../candidate/resume.txt');
export const RESUME_FILE = path.resolve(__dirname, '../../../../candidate/resume.tex');

export function readResume(file?: string): string {
  for (const f of file ? [file] : [RESUME_TEXT_FILE, RESUME_FILE]) {
    try {
      // LaTeX commands are not skills: keep the words, drop \commands.
      return fs.readFileSync(f, 'utf8').replace(/\\[a-zA-Z]+\*?/g, ' ');
    } catch {
      // try the next one
    }
  }
  return '';
}

export function saveInsights(i: Insights, file = insightsFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(i, null, 1));
}

export function loadInsights(file = insightsFile()): Insights | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Insights;
  } catch {
    return null;
  }
}
