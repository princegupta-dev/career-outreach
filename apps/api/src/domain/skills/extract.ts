import { findSkills, getSkill } from './taxonomy';

export type Seniority = 'intern' | 'junior' | 'mid' | 'senior' | 'lead' | 'staff' | 'principal' | 'manager' | 'unknown';
export type WorkMode = 'remote' | 'hybrid' | 'onsite' | 'unknown';

export interface SalaryInfo {
  min: number | null;
  max: number | null;
  currency: string;
  period: 'year' | 'month' | 'hour';
  raw: string;
}

export interface JobExtraction {
  requiredSkills: string[];
  preferredSkills: string[];
  /** Skill → mention count (emphasis signal). */
  skillCounts: Record<string, number>;
  minYears: number | null;
  maxYears: number | null;
  seniority: Seniority;
  workMode: WorkMode;
  /** e.g. "US only", "must be authorized to work in the US". Empty if none detected. */
  locationRestrictions: string[];
  visaSponsorship: 'yes' | 'no' | 'unknown';
  salary: SalaryInfo | null;
  roleFamily: RoleFamily;
  wordCount: number;
}

export type RoleFamily =
  | 'backend'
  | 'fullstack'
  | 'platform'
  | 'software'
  | 'ai_backend'
  | 'data'
  | 'frontend'
  | 'mobile'
  | 'devops'
  | 'management'
  | 'non_engineering';

const PREFERRED_HEADING =
  /(nice[\s-]to[\s-]have|good[\s-]to[\s-]have|bonus|preferred|desirable|pluses|plus points|would be (a )?(great|nice|plus)|extra credit|not required)/i;
const REQUIRED_HEADING =
  /(requirements|qualifications|must[\s-]have|what you('ll)? (need|bring)|what we('re)? looking for|you (have|bring|should have)|about you|skills|responsibilities|what you('ll)? do|tech stack|our stack|the role)/i;
const INLINE_PREFERRED = /(nice to have|is a plus|a plus\b|bonus|preferred|good to have|ideally|familiarity with)/i;

/** Normalise whitespace and strip HTML remnants. */
export function normalizeText(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isHeading(line: string): boolean {
  const t = line.trim();
  return t.length > 0 && t.length < 80 && (/[:：]$/.test(t) || /^#+\s/.test(t) || /^[A-Z][A-Za-z '&/-]+$/.test(t));
}

export function splitRequiredPreferred(description: string): { required: Map<string, number>; preferred: Map<string, number> } {
  const required = new Map<string, number>();
  const preferred = new Map<string, number>();
  let mode: 'required' | 'preferred' = 'required';
  for (const line of normalizeText(description).split('\n')) {
    if (isHeading(line)) {
      if (PREFERRED_HEADING.test(line)) mode = 'preferred';
      else if (REQUIRED_HEADING.test(line)) mode = 'required';
    }
    const lineMode = INLINE_PREFERRED.test(line) ? 'preferred' : mode;
    for (const [skill, count] of findSkills(line)) {
      const target = lineMode === 'preferred' ? preferred : required;
      target.set(skill, (target.get(skill) ?? 0) + count);
    }
  }
  // A skill required anywhere is required.
  for (const skill of required.keys()) preferred.delete(skill);
  return { required, preferred };
}

const YEARS_RE =
  /(\d{1,2})\s*(?:\+|plus)?\s*(?:(?:-|–|—|to)\s*(\d{1,2})\s*\+?)?\s*(?:years?|yrs?)(?:'|’)?(?:\s+of)?(?:\s+\w+){0,4}?\s+(?:experience|exp\b)/gi;
const YEARS_RE_ALT = /(?:minimum|at least|min\.?)\s+(?:of\s+)?(\d{1,2})\s*\+?\s*(?:years?|yrs?)/gi;

export function extractYears(text: string): { min: number | null; max: number | null } {
  const mins: number[] = [];
  const maxes: number[] = [];
  for (const re of [YEARS_RE, YEARS_RE_ALT]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const a = Number(m[1]);
      const b = m[2] ? Number(m[2]) : null;
      if (a > 0 && a <= 20) mins.push(a);
      if (b && b >= a && b <= 25) maxes.push(b);
    }
  }
  if (!mins.length) return { min: null, max: null };
  // The headline requirement is usually the largest minimum ("5+ years overall, 2+ with Go").
  return { min: Math.max(...mins), max: maxes.length ? Math.max(...maxes) : null };
}

export function detectSeniority(title: string, text = ''): Seniority {
  const t = title.toLowerCase();
  if (/\b(intern|internship|trainee|apprentice)\b/.test(t)) return 'intern';
  if (/\b(engineering manager|manager|head of|director|vp)\b/.test(t) && !/\bproduct manager\b/.test(t)) return 'manager';
  if (/\bprincipal\b|\bdistinguished\b|\barchitect\b/.test(t)) return 'principal';
  if (/\bstaff\b/.test(t)) return 'staff';
  if (/\b(lead|tech lead|team lead)\b/.test(t)) return 'lead';
  if (/\b(senior|sr\.?|sde[\s-]?(iii|3)|engineer[\s-]?(iii|3)|level 3|l5)\b/.test(t)) return 'senior';
  if (/\b(new[\s-]?grad(uate)?|early[\s-]career|university|campus|graduate|junior|jr\.?|entry[\s-]level|fresher|associate|sde[\s-]?(i|1)|engineer[\s-]?(i|1))\b/.test(t)) return 'junior';
  if (/\b(mid|intermediate|sde[\s-]?(ii|2)|engineer[\s-]?(ii|2))\b/.test(t)) return 'mid';
  if (/\bsenior\b/i.test(text.slice(0, 400))) return 'senior';
  return 'unknown';
}

export function detectWorkMode(text: string, location = ''): WorkMode {
  const s = `${location}\n${text}`.toLowerCase();
  const remoteNegated = /(not (a )?remote|no remote|non-remote|remote (is )?not (possible|available|an option))/.test(s);
  if (/\bhybrid\b/.test(s)) return 'hybrid';
  if (!remoteNegated && /\b(remote|work from home|wfh|work from anywhere|distributed team|remote-first)\b/.test(s)) return 'remote';
  if (/\b(on-?site|in[- ]office|work from office|wfo|office-based)\b/.test(s) || remoteNegated) return 'onsite';
  return 'unknown';
}

const RESTRICTION_PATTERNS: Array<[RegExp, string]> = [
  [/\b(us|u\.s\.|united states)[- ]only\b/i, 'US only'],
  [/authori[sz]ed to work in the (us|u\.s\.|united states)/i, 'Must be authorized to work in the US'],
  [/\b(must|should) (be )?(located|based|reside) in (the )?(us|u\.s\.|united states|usa)\b/i, 'Must be located in the US'],
  [/\b(must|should) (be )?(located|based|reside) in (the )?(uk|united kingdom)\b/i, 'Must be located in the UK'],
  [/\b(must|should) (be )?(located|based|reside) in (the )?(eu|europe|european union)\b/i, 'Must be located in the EU'],
  [/\b(eu|europe)[- ]only\b/i, 'EU only'],
  [/\b(uk)[- ]only\b/i, 'UK only'],
  [/\b(us|north america|americas) time ?zones? (only|required)\b/i, 'US time zones required'],
  [/\bsecurity clearance\b/i, 'Security clearance required'],
];

export function detectLocationRestrictions(text: string): string[] {
  return RESTRICTION_PATTERNS.filter(([re]) => re.test(text)).map(([, label]) => label);
}

export function detectVisaSponsorship(text: string): 'yes' | 'no' | 'unknown' {
  const s = text.toLowerCase();
  if (/(no|not|unable to|cannot|can't|won't|will not)\s+(offer\s+|provide\s+)?(visa\s+)?sponsor/.test(s)) return 'no';
  if (/(visa sponsorship (is )?(available|provided|offered)|we (will )?sponsor visas?|relocation and visa support)/.test(s)) return 'yes';
  return 'unknown';
}

function toNumber(raw: string, suffix?: string): number {
  const n = Number(raw.replace(/,/g, ''));
  const s = (suffix ?? '').toLowerCase();
  if (s === 'k') return n * 1_000;
  if (s === 'm' || s === 'mn') return n * 1_000_000;
  if (s === 'l' || s === 'lpa' || s === 'lakh' || s === 'lakhs' || s === 'lac' || s === 'lacs') return n * 100_000;
  if (s === 'cr' || s === 'crore') return n * 10_000_000;
  return n;
}

/** Parses common salary formats: "₹30-40 LPA", "INR 30,00,000 – 40,00,000", "$150k–$180k", "€80,000". */
export function parseSalary(text: string): SalaryInfo | null {
  const lpa = /(?:₹|inr|rs\.?)?\s*(\d{1,3}(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d{1,3}(?:\.\d+)?)\s*(lpa|lakhs?|lacs?|l\b)/i.exec(text);
  if (lpa) {
    return { min: toNumber(lpa[1], 'l'), max: toNumber(lpa[2], 'l'), currency: 'INR', period: 'year', raw: lpa[0].trim() };
  }
  const lpaSingle = /(?:₹|inr|rs\.?)?\s*(\d{1,3}(?:\.\d+)?)\s*(lpa)\b/i.exec(text);
  if (lpaSingle) {
    const v = toNumber(lpaSingle[1], 'l');
    return { min: v, max: v, currency: 'INR', period: 'year', raw: lpaSingle[0].trim() };
  }
  const symbols: Record<string, string> = { $: 'USD', usd: 'USD', '€': 'EUR', eur: 'EUR', '£': 'GBP', gbp: 'GBP', '₹': 'INR', inr: 'INR', cad: 'CAD', aud: 'AUD', sgd: 'SGD' };
  const range =
    /(\$|€|£|₹|usd|eur|gbp|inr|cad|aud|sgd)\s?(\d{1,3}(?:,\d{2,3})*(?:\.\d+)?)\s*(k|m)?\s*(?:-|–|—|to)\s*(?:\$|€|£|₹|usd|eur|gbp|inr|cad|aud|sgd)?\s?(\d{1,3}(?:,\d{2,3})*(?:\.\d+)?)\s*(k|m)?(\s*(?:\/|per)\s*(?:year|yr|annum|month|mo|hour|hr))?/i.exec(
      text,
    );
  if (range) {
    const currency = symbols[range[1].toLowerCase()] ?? 'USD';
    const min = toNumber(range[2], range[3] ?? range[5]);
    const max = toNumber(range[4], range[5] ?? range[3]);
    const periodRaw = (range[6] ?? '').toLowerCase();
    const period = /month|mo/.test(periodRaw) ? 'month' : /hour|hr/.test(periodRaw) ? 'hour' : 'year';
    if (min > 0 && max >= min) return { min, max, currency, period, raw: range[0].trim() };
  }
  return null;
}

/** Annual salary normalised to INR lakhs (only for INR; other currencies are evaluated separately). */
export function salaryInLpa(s: SalaryInfo | null): { min: number | null; max: number | null } | null {
  if (!s || s.currency !== 'INR') return null;
  const mult = s.period === 'month' ? 12 : s.period === 'hour' ? 2000 : 1;
  return {
    min: s.min != null ? (s.min * mult) / 100_000 : null,
    max: s.max != null ? (s.max * mult) / 100_000 : null,
  };
}

export function detectRoleFamily(title: string, skills: string[] = []): RoleFamily {
  const t = title.toLowerCase();
  if (/\b(recruit|sales|marketing|account (executive|manager)|customer success|support|designer|product manager|hr\b|finance|legal|operations)\b/.test(t))
    return 'non_engineering';
  if (/\b(engineering manager|head of engineering|director of engineering|vp of engineering|vp engineering)\b/.test(t)) return 'management';
  if (/\b(front[\s-]?end|ui engineer|web developer)\b/.test(t)) return 'frontend';
  if (/\b(ios|android|mobile|flutter|react native)\b/.test(t)) return 'mobile';
  if (/\b(data (engineer|scientist|analyst)|analytics engineer|machine learning engineer|ml engineer|research scientist)\b/.test(t)) return 'data';
  if (/\b(ai|llm|genai|gen ai)\b/.test(t) && /\b(back[\s-]?end|platform|software)\b/.test(t)) return 'ai_backend';
  if (/\b(full[\s-]?stack)\b/.test(t)) return 'fullstack';
  if (/\b(devops|sre|site reliability|cloud engineer)\b/.test(t)) return 'devops';
  if (/\b(platform|infrastructure|infra)\b/.test(t)) return 'platform';
  if (/\b(back[\s-]?end|server[\s-]?side|api engineer|node(\.js)?|typescript|golang|java|python) (engineer|developer)\b/.test(t) || /\bbackend\b/.test(t))
    return 'backend';
  if (/\b(software|sde|swe|developer|programmer|engineer)\b/.test(t)) {
    const frontendHeavy = skills.filter((s) => getSkill(s)?.category === 'frontend').length;
    const backendHeavy = skills.filter((s) => ['runtime', 'database', 'queue', 'cache', 'orm'].includes(getSkill(s)?.category ?? '')).length;
    if (frontendHeavy > backendHeavy + 2) return 'frontend';
    return 'software';
  }
  return 'non_engineering';
}

export function extractJob(input: { title: string; description: string; location?: string | null; companyName?: string | null }): JobExtraction {
  const text = normalizeText(input.description);
  const { required, preferred } = splitRequiredPreferred(text);
  // Skills in the title are always required.
  for (const [skill, count] of findSkills(input.title)) required.set(skill, (required.get(skill) ?? 0) + count + 2);
  for (const skill of required.keys()) preferred.delete(skill);
  // A company that shares its name with a technology (Sentry, Stripe, Docker…) is not a skill requirement.
  if (input.companyName) {
    const company = input.companyName.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const m of [required, preferred]) for (const skill of [...m.keys()]) if (skill.toLowerCase().replace(/[^a-z0-9]/g, '') === company) m.delete(skill);
  }

  const skillCounts: Record<string, number> = {};
  for (const [k, v] of [...required, ...preferred]) skillCounts[k] = (skillCounts[k] ?? 0) + v;
  const years = extractYears(text);
  const requiredSkills = [...required.keys()];
  return {
    requiredSkills,
    preferredSkills: [...preferred.keys()],
    skillCounts,
    minYears: years.min,
    maxYears: years.max,
    seniority: detectSeniority(input.title, text),
    workMode: detectWorkMode(text, input.location ?? ''),
    locationRestrictions: detectLocationRestrictions(text),
    visaSponsorship: detectVisaSponsorship(text),
    salary: parseSalary(text),
    roleFamily: detectRoleFamily(input.title, requiredSkills),
    wordCount: text.split(/\s+/).filter(Boolean).length,
  };
}
