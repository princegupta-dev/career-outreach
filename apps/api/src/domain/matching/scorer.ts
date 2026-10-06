import type { CompanySize, Recommendation } from '@prisma/client';
import type { CandidateProfile } from '../profile/profile';
import { JobExtraction, RoleFamily, Seniority, salaryInLpa } from '../skills/extract';
import { getSkill } from '../skills/taxonomy';

export const SCORE_VERSION = 'v1';

export type MatchLevel = 'strong' | 'partial' | 'learning' | 'missing';

export interface SkillMatch {
  skill: string;
  level: MatchLevel;
  required: boolean;
  /** Why this was judged partial (e.g. "related: BullMQ"). */
  via?: string;
}

export interface ScoreComponent {
  key: 'role' | 'experience' | 'skills' | 'seniority' | 'location' | 'salary' | 'company';
  label: string;
  score: number;
  max: number;
  reason: string;
}

export interface MatchResult {
  version: string;
  total: number;
  recommendation: Recommendation;
  components: ScoreComponent[];
  skills: SkillMatch[];
  strong: string[];
  partial: string[];
  missing: string[];
  reasons: string[];
  flags: string[];
}

export interface ScoringJob {
  title: string;
  location?: string | null;
  companyName: string;
  companySize?: CompanySize | null;
  companyType?: string | null;
  extraction: JobExtraction;
}

const MAX = { role: 20, experience: 15, skills: 25, seniority: 10, location: 10, salary: 10, company: 10 } as const;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function classifySkill(skill: string, profile: CandidateProfile): { level: MatchLevel; via?: string } {
  const has = (s: string) => profile.strongSkills.includes(s);
  if (has(skill)) return { level: 'strong' };
  if (profile.domainSkills?.includes(skill)) return { level: 'strong', via: 'domain experience' };
  const def = getSkill(skill);
  const implied = def?.impliedBy?.find(has);
  if (implied) return { level: 'strong', via: `implied by ${implied}` };
  if (profile.partialSkills.includes(skill)) return { level: 'partial', via: 'listed as partial in profile' };
  const related = def?.relatedTo?.find((r) => has(r) || profile.partialSkills.includes(r));
  if (related) return { level: 'partial', via: `related experience: ${related}` };
  if (profile.learningSkills.includes(skill)) return { level: 'learning' };
  return { level: 'missing' };
}

function scoreRole(title: string, family: RoleFamily, profile: CandidateProfile): ScoreComponent {
  const t = norm(title);
  const exactTarget = profile.target_roles.find((r) => {
    const nr = norm(r).replace(/^senior /, '');
    return nr.length > 0 && t.includes(nr);
  });
  const table: Record<RoleFamily, [number, string]> = {
    backend: [18, 'Backend role'],
    ai_backend: [16, 'AI/backend role — check the AI depth expected'],
    platform: [14, 'Platform / infrastructure backend role'],
    software: [14, 'General software engineering role'],
    fullstack: [10, 'Full-stack role — backend is only part of it'],
    devops: [7, 'DevOps / SRE role — adjacent, not core backend'],
    data: [4, 'Data / ML role — outside core backend focus'],
    management: [3, 'People-management role'],
    frontend: [1, 'Frontend role'],
    mobile: [1, 'Mobile role'],
    non_engineering: [0, 'Not an engineering role'],
  };
  let [score, reason] = table[family];
  const juniorTitle = /\b(new[\s-]?grad(uate)?|early[\s-]career|junior|intern|entry[\s-]level|university|campus)\b/.test(t);
  if (exactTarget && !juniorTitle && ['backend', 'ai_backend', 'platform', 'software'].includes(family)) {
    score = MAX.role;
    reason = `Title matches target role "${exactTarget}"`;
  }
  return { key: 'role', label: 'Role match', score, max: MAX.role, reason };
}

function scoreExperience(ex: JobExtraction, years: number): ScoreComponent {
  const base = { key: 'experience' as const, label: 'Experience', max: MAX.experience };
  if (ex.minYears == null) return { ...base, score: 11, reason: 'No explicit years requirement found' };
  const gap = ex.minYears - years;
  if (gap <= 0) {
    if (ex.maxYears != null && years - ex.maxYears >= 3) {
      return { ...base, score: 9, reason: `Role asks for ${ex.minYears}-${ex.maxYears} years — may be below your level` };
    }
    return { ...base, score: 15, reason: `Asks for ${ex.minYears}+ years; you have ~${years}` };
  }
  if (gap === 1) return { ...base, score: 10, reason: `Asks for ${ex.minYears}+ years; you have ~${years} (1 year short)` };
  if (gap === 2) return { ...base, score: 5, reason: `Asks for ${ex.minYears}+ years; you have ~${years} (2 years short)` };
  return { ...base, score: 1, reason: `Asks for ${ex.minYears}+ years; you have ~${years} (significant gap)` };
}

function scoreSkills(matches: SkillMatch[]): ScoreComponent {
  const base = { key: 'skills' as const, label: 'Technical skills', max: MAX.skills };
  if (!matches.length) return { ...base, score: 12, reason: 'No recognisable technologies in the description' };
  const value = (m: SkillMatch) => (m.level === 'strong' ? 1 : m.level === 'partial' ? 0.5 : m.level === 'learning' ? 0.2 : 0);
  const weight = (m: SkillMatch) => (m.required ? 1 : 0.4) * (getSkill(m.skill)?.core ? 1.3 : 1);
  const totalW = matches.reduce((a, m) => a + weight(m), 0);
  const got = matches.reduce((a, m) => a + weight(m) * value(m), 0);
  const coverage = totalW ? got / totalW : 0;
  const req = matches.filter((m) => m.required);
  const reqStrong = req.filter((m) => m.level === 'strong').length;
  return {
    ...base,
    score: Math.round(MAX.skills * coverage),
    reason: `${reqStrong}/${req.length} required technologies are strong matches (weighted coverage ${Math.round(coverage * 100)}%)`,
  };
}

function scoreSeniority(level: Seniority, years: number): ScoreComponent {
  const base = { key: 'seniority' as const, label: 'Seniority', max: MAX.seniority };
  const table: Record<Seniority, [number, string]> = {
    senior: [10, 'Senior-level role matches your target'],
    mid: [8, 'Mid-level role — slightly below target, still relevant'],
    lead: [years >= 5 ? 8 : 6, 'Lead role — check scope expectations'],
    unknown: [7, 'Seniority not stated'],
    staff: [years >= 7 ? 8 : 3, 'Staff-level role — usually expects more years'],
    principal: [2, 'Principal/architect role — usually expects much more experience'],
    junior: [3, 'Junior role — below your level'],
    manager: [1, 'Manager role — not an IC position'],
    intern: [0, 'Internship'],
  };
  const [score, reason] = table[level];
  return { ...base, score, reason };
}

function scoreLocation(job: ScoringJob, profile: CandidateProfile): { component: ScoreComponent; flags: string[] } {
  const ex = job.extraction;
  const base = { key: 'location' as const, label: 'Location', max: MAX.location };
  const flags: string[] = [];
  const loc = norm(`${job.location ?? ''}`);
  const targets = profile.target_locations.map(norm).filter(Boolean);
  const inIndia = /\b(india|bangalore|bengaluru|gurgaon|gurugram|noida|delhi|pune|hyderabad|mumbai|chennai|kolkata|ahmedabad|jaipur|indore|chandigarh)\b/.test(loc);
  const matchesTarget = targets.some((t) => t !== 'remote' && loc.includes(t));
  const hardRestriction = ex.locationRestrictions.filter((r) => !/india/i.test(r));
  if (hardRestriction.length) flags.push(...hardRestriction);

  if (ex.workMode === 'remote') {
    if (hardRestriction.length) return { component: { ...base, score: 2, reason: `Remote, but restricted: ${hardRestriction.join(', ')}` }, flags };
    const remoteOk = targets.includes('remote');
    return { component: { ...base, score: remoteOk ? 10 : 7, reason: 'Remote role' }, flags };
  }
  if (matchesTarget) return { component: { ...base, score: 10, reason: `Located in a target location (${job.location})` }, flags };
  if (inIndia) {
    return { component: { ...base, score: profile.open_to_relocation ? 8 : 5, reason: `India, not one of your listed cities (${job.location})` }, flags };
  }
  if (!loc) return { component: { ...base, score: 6, reason: 'Location not stated' }, flags };
  if (hardRestriction.length) return { component: { ...base, score: 1, reason: `Outside India with restrictions: ${hardRestriction.join(', ')}` }, flags };
  const visa = ex.visaSponsorship === 'yes' ? ' (visa sponsorship mentioned)' : ex.visaSponsorship === 'no' ? ' (no visa sponsorship)' : '';
  const score = !profile.open_to_international ? 1 : ex.visaSponsorship === 'no' ? 1 : profile.open_to_relocation || ex.visaSponsorship === 'yes' ? 6 : 3;
  return { component: { ...base, score, reason: `International on-site/hybrid role in ${job.location}${visa}` }, flags };
}

function scoreSalary(ex: JobExtraction, profile: CandidateProfile): ScoreComponent {
  const base = { key: 'salary' as const, label: 'Salary', max: MAX.salary };
  if (!ex.salary) return { ...base, score: 6, reason: 'Salary not disclosed' };
  const lpa = salaryInLpa(ex.salary);
  const target = profile.compensation.india_min_lpa;
  if (lpa && target) {
    const top = lpa.max ?? lpa.min ?? 0;
    if (top >= target) return { ...base, score: 10, reason: `Up to ${top.toFixed(0)} LPA — meets your ${target}+ LPA target` };
    if (top >= target * 0.8) return { ...base, score: 6, reason: `Up to ${top.toFixed(0)} LPA — slightly below your ${target} LPA target` };
    return { ...base, score: 2, reason: `Up to ${top.toFixed(0)} LPA — below your ${target} LPA target` };
  }
  return { ...base, score: 8, reason: `${ex.salary.raw} (${ex.salary.currency}) — international compensation, evaluate separately` };
}

function sizeToPreference(size?: CompanySize | null): string | null {
  switch (size) {
    case 'EARLY_STARTUP':
      return 'early_stage_startup';
    case 'GROWTH_STARTUP':
      return 'growth_stage_startup';
    case 'MID_MARKET':
      return 'mid_market';
    case 'ENTERPRISE':
      return 'enterprise';
    default:
      return null;
  }
}

function scoreCompany(job: ScoringJob, profile: CandidateProfile): { component: ScoreComponent; avoided: boolean } {
  const base = { key: 'company' as const, label: 'Company preference', max: MAX.company };
  const avoided = profile.avoid_companies.some((c) => norm(c) === norm(job.companyName));
  if (avoided) return { component: { ...base, score: 0, reason: 'Company is on your avoid list' }, avoided };
  const pref = sizeToPreference(job.companySize);
  const prefs = profile.company_preferences;
  if (job.companyType && prefs.includes(job.companyType)) {
    return { component: { ...base, score: 10, reason: `Company type "${job.companyType}" is a preference` }, avoided };
  }
  if (pref && prefs.includes(pref)) return { component: { ...base, score: 10, reason: `Company size (${pref.replace(/_/g, ' ')}) is a preference` }, avoided };
  if (pref) return { component: { ...base, score: 4, reason: `Company size (${pref.replace(/_/g, ' ')}) is not in your preferences` }, avoided };
  return { component: { ...base, score: 7, reason: 'Company size/type unknown' }, avoided };
}

export function recommendationFor(total: number): Recommendation {
  if (total >= 80) return 'STRONG_APPLY';
  if (total >= 68) return 'APPLY';
  if (total >= 55) return 'CONSIDER';
  if (total >= 40) return 'LOW_PRIORITY';
  return 'SKIP';
}

const ORDER: Recommendation[] = ['SKIP', 'LOW_PRIORITY', 'CONSIDER', 'APPLY', 'STRONG_APPLY'];
const cap = (r: Recommendation, max: Recommendation): Recommendation => (ORDER.indexOf(r) > ORDER.indexOf(max) ? max : r);

/** Deterministic candidate↔job scoring (0-100). No LLM involved. */
export function scoreJob(job: ScoringJob, profile: CandidateProfile): MatchResult {
  const ex = job.extraction;
  const skills: SkillMatch[] = [
    ...ex.requiredSkills.map((s) => ({ skill: s, required: true, ...classifySkill(s, profile) })),
    ...ex.preferredSkills.map((s) => ({ skill: s, required: false, ...classifySkill(s, profile) })),
  ];
  const role = scoreRole(job.title, ex.roleFamily, profile);
  const experience = scoreExperience(ex, profile.experienceYears);
  const skillComp = scoreSkills(skills);
  const seniority = scoreSeniority(ex.seniority, profile.experienceYears);
  const { component: location, flags } = scoreLocation(job, profile);
  const salary = scoreSalary(ex, profile);
  const { component: company, avoided } = scoreCompany(job, profile);
  const components = [role, experience, skillComp, seniority, location, salary, company];
  const total = Math.max(0, Math.min(100, components.reduce((a, c) => a + c.score, 0)));

  let recommendation = recommendationFor(total);
  const reasons: string[] = [];
  if (avoided) {
    recommendation = 'SKIP';
    reasons.push('Company is on your avoid list.');
  }
  if (role.score <= 3) {
    recommendation = cap(recommendation, 'SKIP');
    reasons.push(`${role.reason} — outside your target roles.`);
  }
  if (ex.seniority === 'intern' || ex.seniority === 'manager') recommendation = cap(recommendation, 'LOW_PRIORITY');
  if (location.score <= 2) {
    recommendation = cap(recommendation, 'LOW_PRIORITY');
    reasons.push(`Location is a likely blocker: ${location.reason}.`);
  }
  const coreMissing = skills.filter((s) => s.required && s.level === 'missing' && ['language', 'runtime'].includes(getSkill(s.skill)?.category ?? ''));
  const coreStrong = skills.filter((s) => s.level === 'strong' && ['language', 'runtime'].includes(getSkill(s.skill)?.category ?? ''));
  if (coreMissing.length && !coreStrong.length) {
    recommendation = cap(recommendation, 'CONSIDER');
    reasons.push(`Primary language(s) ${coreMissing.map((s) => s.skill).join(', ')} not in your profile.`);
  }

  const strong = skills.filter((s) => s.level === 'strong').map((s) => s.skill);
  const partial = skills.filter((s) => s.level === 'partial' || s.level === 'learning').map((s) => s.skill);
  const missing = skills.filter((s) => s.level === 'missing' && s.required).map((s) => s.skill);
  const best = [...components].sort((a, b) => b.score / b.max - a.score / a.max).slice(0, 2);
  reasons.unshift(...best.map((c) => `${c.label}: ${c.reason}.`));
  if (strong.length) reasons.push(`Strong overlap: ${strong.slice(0, 6).join(', ')}.`);
  if (missing.length) reasons.push(`Gaps to address honestly: ${missing.slice(0, 5).join(', ')}.`);

  return { version: SCORE_VERSION, total, recommendation, components, skills, strong, partial, missing, reasons, flags };
}
