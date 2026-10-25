import type { CompanySize, Recommendation } from '@prisma/client';
import type { MatchResult } from '../../domain/matching/scorer';
import type { JobExtraction } from '../../domain/skills/extract';
import { classifyPosting } from '../../providers/jobs/job-provider.interface';

/** The four answers the user sees to "should I apply?". Derived from the existing recommendation — scoring itself is unchanged. */
export type Verdict = 'STRONG_MATCH' | 'GOOD_MATCH' | 'REVIEW_MANUALLY' | 'NOT_RECOMMENDED';

export const VERDICT_LABEL: Record<Verdict, string> = {
  STRONG_MATCH: 'Strong match',
  GOOD_MATCH: 'Good match',
  REVIEW_MANUALLY: 'Review manually',
  NOT_RECOMMENDED: 'Not recommended',
};

export function verdictFor(rec: Recommendation | null | undefined): Verdict {
  switch (rec) {
    case 'STRONG_APPLY':
      return 'STRONG_MATCH';
    case 'APPLY':
      return 'GOOD_MATCH';
    case 'LOW_PRIORITY':
    case 'SKIP':
      return 'NOT_RECOMMENDED';
    default:
      return 'REVIEW_MANUALLY'; // CONSIDER, or not scored yet
  }
}

/** Recommendation values behind each verdict (for list filters). */
export const RECOMMENDATIONS_OF: Record<Verdict, Recommendation[]> = {
  STRONG_MATCH: ['STRONG_APPLY'],
  GOOD_MATCH: ['APPLY'],
  REVIEW_MANUALLY: ['CONSIDER'],
  NOT_RECOMMENDED: ['LOW_PRIORITY', 'SKIP'],
};

export interface SummaryInput {
  title: string;
  location: string | null;
  remote: boolean | null;
  score: number | null;
  recommendation: Recommendation | null;
  scoreBreakdown: MatchResult | null;
  extracted: JobExtraction | null;
  eligibility: string;
  eligibilityFlags: string[];
  salaryMin: number | null;
  salaryMax: number | null;
  postedAt: Date | null;
  company: { size: CompanySize; teamSize: number | null; provenance: unknown };
}

export interface Fact {
  /** False when the value could not be established. The UI shows "Unknown" instead of guessing. */
  known: boolean;
  label: string;
  /** Where the value came from, when we know. */
  source?: string;
}

export interface JobSummary {
  verdict: Verdict;
  verdictLabel: string;
  score: number | null;
  explanation: string;
  facts: {
    salary: { known: boolean };
    experience: Fact;
    location: Fact & { status: 'open' | 'uncertain' | 'restricted' };
    companySize: Fact;
  };
  whyMatches: string[];
  toVerify: string[];
  skills: { missingRequired: string[]; missingPreferred: string[]; partial: string[] };
}

const UNKNOWN_REASON = /unknown|not disclosed|not stated|not listed/i;

const SOURCE_NAME: Record<string, string> = { 'yc-oss': 'YC startup directory' };

function locationFact(i: SummaryInput): JobSummary['facts']['location'] {
  const ex = i.extracted;
  const restrictions = (ex?.locationRestrictions ?? []).filter((r) => !/india/i.test(r));
  if (restrictions.length) return { known: true, status: 'restricted', label: `Restricted: ${restrictions.join(', ')}`, source: 'job description' };
  const where = classifyPosting(i.location, i.title);
  if (where === 'restricted') return { known: true, status: 'restricted', label: i.location ? `Posted for ${i.location}` : 'Restricted region', source: 'job posting' };
  if (i.eligibility === 'UNCERTAIN' || where === 'unspecified') {
    return { known: false, status: 'uncertain', label: i.remote || /remote/i.test(i.location ?? '') ? 'Remote — region not stated' : 'Location not stated', source: 'job posting' };
  }
  if (where === 'india') return { known: true, status: 'open', label: i.location ?? 'India', source: 'job posting' };
  // "Remote (Worldwide)" already says it; only add the word when the location does not.
  return { known: true, status: 'open', label: /remote/i.test(i.location ?? '') ? i.location! : `Remote — ${i.location ?? 'worldwide'}`, source: 'job posting' };
}

function experienceFact(ex: JobExtraction | null): Fact {
  if (ex?.minYears) return { known: true, label: `${ex.minYears}+ years`, source: 'job description' };
  return { known: false, label: 'Not stated' };
}

function companySizeFact(c: SummaryInput['company']): Fact {
  const src = (c.provenance as { source?: string } | null)?.source;
  if (c.teamSize) return { known: true, label: `~${c.teamSize} people`, source: src ? (SOURCE_NAME[src] ?? src) : undefined };
  if (c.size !== 'UNKNOWN') {
    const bucket = { EARLY_STARTUP: 'Early-stage startup', GROWTH_STARTUP: 'Growth-stage startup', MID_MARKET: 'Mid-size company', ENTERPRISE: 'Large enterprise' }[c.size];
    return { known: true, label: bucket, source: 'set on the company record' };
  }
  return { known: false, label: 'Unknown' };
}

const FLAG_TEXT: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [/^seniority:(.+)$/, (m) => `The title suggests a more senior level than you asked for ("${m[1]}").`],
  [/^stack:(.+)$/, (m) => `The title points to a different main stack ("${m[1]}") — check the real requirements.`],
  [/^adjacent:(.+)$/, (m) => `This may be an adjacent discipline ("${m[1]}"), not core backend work.`],
  [/^age:older-than-(\d+)d$/, (m) => `First published over ${m[1]} days ago — confirm it is still open.`],
  [/^age:unknown$/, () => 'The posting date is unknown.'],
  [/^location:requires-relocation$/, () => 'The role is based outside India and may need relocation.'],
];

/** Everything the page needs to answer "what should I do with this job?" without showing scoring internals. */
export function summarizeJob(i: SummaryInput): JobSummary {
  const verdict = verdictFor(i.recommendation);
  const bd = i.scoreBreakdown;
  const location = locationFact(i);
  const experience = experienceFact(i.extracted);
  const companySize = companySizeFact(i.company);
  const salaryKnown = i.salaryMin != null || i.salaryMax != null;

  // Skills
  const skills = bd?.skills ?? [];
  const required = skills.filter((s) => s.required);
  const requiredStrong = required.filter((s) => s.level === 'strong');
  const missingRequired = required.filter((s) => s.level === 'missing').map((s) => s.skill);
  const missingPreferred = skills.filter((s) => !s.required && s.level === 'missing').map((s) => s.skill);
  const partial = skills.filter((s) => s.level === 'partial' || s.level === 'learning').map((s) => s.skill);

  // Why it matches: the strong parts of the score, in the scorer's own words; never the "unknown" defaults.
  const whyMatches: string[] = [];
  for (const c of [...(bd?.components ?? [])].sort((a, b) => b.max - a.max)) {
    if (c.max && c.score / c.max >= 0.7 && !UNKNOWN_REASON.test(c.reason)) whyMatches.push(c.reason);
  }
  if (bd?.strong.length) whyMatches.unshift(`You already use ${bd.strong.slice(0, 5).join(', ')}.`);

  // Things to verify: unknowns first, then soft flags, then the scorer's own red flags.
  const toVerify: string[] = [];
  if (location.status === 'uncertain') toVerify.push(`Location eligibility isn't stated (${location.label.toLowerCase()}) — confirm you can work from India.`);
  if (location.status === 'restricted') toVerify.push(`${location.label}. This may not be open to candidates in India.`);
  if (!salaryKnown) toVerify.push("Salary isn't disclosed.");
  if (!experience.known) toVerify.push("Required experience isn't stated.");
  if (!companySize.known) toVerify.push('Company size is unknown.');
  for (const f of i.eligibilityFlags) {
    for (const [re, text] of FLAG_TEXT) {
      const m = re.exec(f);
      if (m) {
        toVerify.push(text(m));
        break;
      }
    }
  }
  for (const f of bd?.flags ?? []) if (!toVerify.some((t) => t.includes(f))) toVerify.push(f);

  // One honest sentence.
  const lead = { STRONG_MATCH: 'Strong match', GOOD_MATCH: 'Good match', REVIEW_MANUALLY: 'Worth a manual look', NOT_RECOMMENDED: 'Not a good fit' }[verdict];
  const parts: string[] = [];
  if (required.length) parts.push(`${requiredStrong.length} of ${required.length} required skills match${requiredStrong.length ? ` (${requiredStrong.slice(0, 4).map((s) => s.skill).join(', ')})` : ''}`);
  if (location.known) parts.push(location.label.toLowerCase().startsWith('restricted') ? location.label : `location: ${location.label}`);
  else parts.push('location is unclear');
  const explanation = i.score == null ? 'This job has not been scored yet.' : `${lead} at ${i.score}%${parts.length ? ` — ${parts.join('; ')}` : ''}.`;

  return {
    verdict,
    verdictLabel: VERDICT_LABEL[verdict],
    score: i.score,
    explanation,
    facts: { salary: { known: salaryKnown }, experience, location, companySize },
    whyMatches: whyMatches.slice(0, 4),
    toVerify,
    skills: { missingRequired, missingPreferred, partial },
  };
}
