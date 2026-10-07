import type { CompanySize, Recommendation } from '@prisma/client';
import type { CandidateProfile } from '../profile/profile';
import { JobExtraction, RoleFamily, Seniority, salaryInLpa } from '../skills/extract';
import { getSkill } from '../skills/taxonomy';
import { currentEmployerMatcher } from '../outreach/guardrails';

export const SCORE_VERSION = 'v2';

export type MatchLevel = 'strong' | 'partial' | 'learning' | 'missing';

export interface SkillMatch {
  skill: string;
  level: MatchLevel;
  required: boolean;
  /** Why this was judged partial (e.g. "related: BullMQ"). */
  via?: string;
}

export type ComponentKey = 'technical' | 'seniority' | 'role' | 'location' | 'compensation' | 'ai' | 'company' | 'freshness';

/** Simple three-way decision exposed to dashboards / automation. */
export type Decision = 'APPLY' | 'CONSIDER' | 'SKIP';

/** Flat breakdown in the shape the dashboard API returns. */
export interface ScoreBreakdown {
  score: number;
  technical_score: number;
  seniority_score: number;
  role_score: number;
  location_score: number;
  compensation_score: number;
  ai_score: number;
  company_score: number;
  freshness_score: number;
  strong_matches: string[];
  gaps: string[];
  recommendation: Decision;
}

export interface ScoreComponent {
  key: ComponentKey;
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
  decision: Decision;
  breakdown: ScoreBreakdown;
}

export interface ScoringJob {
  title: string;
  location?: string | null;
  companyName: string;
  companySize?: CompanySize | null;
  companyType?: string | null;
  extraction: JobExtraction;
  /** Used for the freshness component. Unknown dates get a neutral score. */
  postedAt?: Date | null;
}

/** Final weights (sum = 100). */
export const WEIGHTS: Record<ComponentKey, number> = { technical: 30, seniority: 20, role: 15, location: 10, compensation: 10, ai: 5, company: 5, freshness: 5 };

/** Raw sub-scores (computed on their own scales, then rescaled to WEIGHTS). */
const MAX = { role: 20, experience: 15, skills: 25, seniority: 10, location: 10, salary: 10, company: 10 } as const;

interface RawComponent {
  score: number;
  max: number;
  reason: string;
}

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

function scoreRole(title: string, family: RoleFamily, profile: CandidateProfile): RawComponent {
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
  return { score, max: MAX.role, reason };
}

function scoreExperience(ex: JobExtraction, years: number): RawComponent {
  const base = { max: MAX.experience };
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

function scoreSkills(matches: SkillMatch[]): RawComponent {
  const base = { max: MAX.skills };
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

function scoreSeniority(level: Seniority, years: number): RawComponent {
  const base = { max: MAX.seniority };
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

function scoreLocation(job: ScoringJob, profile: CandidateProfile): { component: RawComponent; flags: string[] } {
  const ex = job.extraction;
  const base = { max: MAX.location };
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

function scoreSalary(ex: JobExtraction, profile: CandidateProfile): RawComponent {
  const base = { max: MAX.salary };
  // Undisclosed salary is neutral — never a reason to skip a strong job.
  if (!ex.salary) return { ...base, score: 7, reason: 'Salary not disclosed (neutral)' };
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

function scoreCompany(job: ScoringJob, profile: CandidateProfile): { component: RawComponent; avoided: boolean; employer: boolean } {
  const base = { max: MAX.company };
  const employer = currentEmployerMatcher(profile.current_company)(job.companyName);
  if (employer) return { component: { ...base, score: 0, reason: 'Your current employer' }, avoided: true, employer };
  const avoided = profile.avoid_companies.some((c) => norm(c) === norm(job.companyName));
  if (avoided) return { component: { ...base, score: 0, reason: 'Company is on your avoid list' }, avoided, employer };
  const pref = sizeToPreference(job.companySize);
  const prefs = profile.company_preferences;
  if (job.companyType && prefs.includes(job.companyType)) {
    return { component: { ...base, score: 10, reason: `Company type "${job.companyType}" is a preference` }, avoided, employer };
  }
  if (pref && prefs.includes(pref)) return { component: { ...base, score: 10, reason: `Company size (${pref.replace(/_/g, ' ')}) is a preference` }, avoided, employer };
  if (pref) return { component: { ...base, score: 4, reason: `Company size (${pref.replace(/_/g, ' ')}) is not in your preferences` }, avoided, employer };
  return { component: { ...base, score: 7, reason: 'Company size/type unknown' }, avoided, employer };
}

/** AI relevance (raw 0-5): GenAI product work the profile actually covers scores highest; ML research lowest. */
function scoreAi(skills: SkillMatch[]): RawComponent {
  const ai = skills.filter((s) => getSkill(s.skill)?.category === 'ai');
  const base = { max: 5 };
  if (!ai.length) return { ...base, score: 3, reason: 'No AI requirements — neutral' };
  const mlHeavy = ai.some((s) => s.skill === 'Machine Learning' && s.required && s.level === 'missing');
  if (mlHeavy) return { ...base, score: 1, reason: 'ML model work required — outside your GenAI-integration experience' };
  const strong = ai.filter((s) => s.level === 'strong').map((s) => s.skill);
  if (strong.length) return { ...base, score: 5, reason: `AI work you have done: ${strong.join(', ')}` };
  return { ...base, score: 2, reason: `AI skills you have not used professionally: ${ai.map((s) => s.skill).join(', ')}` };
}

/** Freshness (raw 0-5): today 5, ≤3 days 4, ≤7 days 3, ≤14 days 2, ≤30 days 1, older 0, unknown 2. */
export function freshnessScore(postedAt: Date | null | undefined, now = new Date()): RawComponent {
  const base = { max: 5 };
  if (!postedAt) return { ...base, score: 2, reason: 'Posting date unknown' };
  const days = (now.getTime() - postedAt.getTime()) / 86_400_000;
  if (days <= 1) return { ...base, score: 5, reason: 'Posted in the last 24 hours' };
  if (days <= 3) return { ...base, score: 4, reason: 'Posted in the last 72 hours' };
  if (days <= 7) return { ...base, score: 3, reason: 'Posted in the last 7 days' };
  if (days <= 14) return { ...base, score: 2, reason: 'Posted in the last 2 weeks' };
  if (days <= 30) return { ...base, score: 1, reason: 'Posted in the last 30 days' };
  return { ...base, score: 0, reason: `Posted ${Math.floor(days)} days ago` };
}

const LABELS: Record<ComponentKey, string> = {
  technical: 'Technical stack',
  seniority: 'Experience / seniority',
  role: 'Role',
  location: 'Location',
  compensation: 'Compensation',
  ai: 'AI relevance',
  company: 'Company / product',
  freshness: 'Freshness',
};

function scaled(key: ComponentKey, raw: RawComponent): ScoreComponent {
  const max = WEIGHTS[key];
  return { key, label: LABELS[key], max, score: Math.round((raw.score / raw.max) * max), reason: raw.reason };
}

export function decisionFor(r: Recommendation): Decision {
  return r === 'STRONG_APPLY' || r === 'APPLY' ? 'APPLY' : r === 'CONSIDER' ? 'CONSIDER' : 'SKIP';
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
export function scoreJob(job: ScoringJob, profile: CandidateProfile, now = new Date()): MatchResult {
  const ex = job.extraction;
  const skills: SkillMatch[] = [
    ...ex.requiredSkills.map((s) => ({ skill: s, required: true, ...classifySkill(s, profile) })),
    ...ex.preferredSkills.map((s) => ({ skill: s, required: false, ...classifySkill(s, profile) })),
  ];
  const roleRaw = scoreRole(job.title, ex.roleFamily, profile);
  const experience = scoreExperience(ex, profile.experienceYears);
  const seniorityRaw = scoreSeniority(ex.seniority, profile.experienceYears);
  const { component: locationRaw, flags } = scoreLocation(job, profile);
  const { component: companyRaw, avoided, employer } = scoreCompany(job, profile);

  const technical = scaled('technical', scoreSkills(skills));
  const seniority = scaled('seniority', {
    score: experience.score + seniorityRaw.score,
    max: experience.max + seniorityRaw.max,
    reason: `${experience.reason}; ${seniorityRaw.reason}`,
  });
  const role = scaled('role', roleRaw);
  const location = scaled('location', locationRaw);
  const compensation = scaled('compensation', scoreSalary(ex, profile));
  const ai = scaled('ai', scoreAi(skills));
  const company = scaled('company', companyRaw);
  const freshness = scaled('freshness', freshnessScore(job.postedAt, now));
  const components = [technical, seniority, role, location, compensation, ai, company, freshness];
  const total = Math.max(0, Math.min(100, components.reduce((a, c) => a + c.score, 0)));

  let recommendation = recommendationFor(total);
  const reasons: string[] = [];
  if (employer) {
    recommendation = 'SKIP';
    reasons.push('This is your current employer — never contacted.');
  } else if (avoided) {
    recommendation = 'SKIP';
    reasons.push('Company is on your avoid list.');
  }
  if (roleRaw.score <= 3) {
    recommendation = cap(recommendation, 'SKIP');
    reasons.push(`${roleRaw.reason} — outside your target roles.`);
  }
  if (ex.seniority === 'intern' || ex.seniority === 'manager') recommendation = cap(recommendation, 'LOW_PRIORITY');
  if (locationRaw.score <= 2) {
    recommendation = cap(recommendation, 'LOW_PRIORITY');
    reasons.push(`Location is a likely blocker: ${locationRaw.reason}.`);
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

  const decision = decisionFor(recommendation);
  const gaps = [...missing, ...flags.map((f) => `Location restriction: ${f}`)];
  if (ex.minYears != null && ex.minYears > profile.experienceYears) gaps.push(`Asks for ${ex.minYears}+ years (you have ~${profile.experienceYears})`);
  const by = Object.fromEntries(components.map((c) => [c.key, c.score])) as Record<ComponentKey, number>;
  const breakdown: ScoreBreakdown = {
    score: total,
    technical_score: by.technical,
    seniority_score: by.seniority,
    role_score: by.role,
    location_score: by.location,
    compensation_score: by.compensation,
    ai_score: by.ai,
    company_score: by.company,
    freshness_score: by.freshness,
    strong_matches: strong,
    gaps,
    recommendation: decision,
  };
  return { version: SCORE_VERSION, total, recommendation, components, skills, strong, partial, missing, reasons, flags, decision, breakdown };
}
