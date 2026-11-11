import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CandidateProfile } from '../domain/profile/profile';
import { findSkills } from '../domain/skills/taxonomy';

/**
 * Answers to the questions job sites ask when you apply (Naukri, Hirist, Instahyre...).
 * The file lives outside the repo (it holds your CTC). It is built from:
 *   1. the question bank below, answered from your profile and the facts you gave;
 *   2. your own edits (they always win over the bank);
 *   3. questions met while applying that nothing could answer, saved to QUESTIONS_FILE for you to answer once.
 * A question is answered only when one entry matches it best; otherwise that application stops. Nothing is invented.
 */
/** Paths are read when used (not at import), so tests can point them at a temp folder and never touch your files. */
export const answersFile = () => process.env.JOB_HUNTER_ANSWERS ?? path.join(os.homedir(), '.job-hunter', 'answers.json');
export const questionsFile = () => process.env.JOB_HUNTER_QUESTIONS ?? path.join(os.homedir(), '.job-hunter', 'unanswered-questions.json');

export interface Answer {
  /** Every one of these words/phrases must appear in the question (case-insensitive). More words = more specific. */
  match: string[];
  answer: string;
  /** Where it came from: 'profile' or 'facts' (built by the tool), or 'you' / no value (written by you — always wins). */
  source?: string;
}

/** Facts not in the profile file, given by you. Change them here or edit answers.json directly. */
export interface Facts {
  noticePeriodDays: number;
  currentCtc: string;
  expectedCtc: string;
  currentLocation: string;
  willingToRelocate: 'Yes' | 'No' | null;
}

export const FACTS: Facts = {
  noticePeriodDays: 30,
  currentCtc: '12 LPA',
  expectedCtc: '17 LPA',
  currentLocation: 'Gurugram',
  willingToRelocate: 'Yes',
};

/**
 * Skills the profile says you do NOT use professionally. Questions about years with these are never answered
 * automatically (your profile: do not present Go, Kafka, Kubernetes... as production experience).
 */
const NEVER_CLAIM = ['java', 'golang', 'go lang', 'kafka', 'kubernetes', 'k8s', 'python', 'react', 'angular', 'vue', 'c#', '.net', 'php', 'ruby', 'scala', 'rust', 'c++', 'spring'];

/** The question bank: what Naukri, Hirist and Instahyre ask most, answered from your profile and facts. */
export function buildAnswers(p: CandidateProfile, f: Facts = FACTS): Answer[] {
  const years = String(p.experienceYears);
  const edu = p.education[0];
  const a = (match: string[], answer: string | number | null | undefined, source: 'profile' | 'facts' = 'profile'): Answer[] =>
    answer === null || answer === undefined || answer === '' ? [] : [{ match, answer: String(answer), source }];

  const skillYears = p.strongSkills
    .filter((s) => !NEVER_CLAIM.includes(s.toLowerCase()))
    .flatMap((s) => {
      const names = [...new Set([s.toLowerCase(), s.toLowerCase().replace(/\.js$/, ''), s.toLowerCase().replace(/\s+apis?$/, '')])].filter((n) => n.length >= 3);
      return names.map((n) => ({ match: [n, 'experience'], answer: years, source: 'profile' }));
    });

  return [
    // Experience
    ...a(['total', 'experience'], years),
    ...a(['relevant', 'experience'], years),
    ...a(['backend', 'experience'], years),
    ...a(['software development', 'experience'], years),
    ...skillYears,
    // Notice period and joining
    ...a(['notice period'], `${f.noticePeriodDays} days`, 'facts'),
    ...a(['notice period', 'days'], f.noticePeriodDays, 'facts'),
    ...a(['notice period', 'months'], f.noticePeriodDays >= 30 ? Math.round(f.noticePeriodDays / 30) : 0, 'facts'),
    ...a(['immediate', 'join'], f.noticePeriodDays === 0 ? 'Yes' : 'No', 'facts'),
    ...a(['immediately', 'available'], f.noticePeriodDays === 0 ? 'Yes' : 'No', 'facts'),
    ...a(['how soon', 'join'], `${f.noticePeriodDays} days`, 'facts'),
    ...a(['serving', 'notice'], 'No', 'facts'),
    ...a(['currently', 'employed'], 'Yes'),
    // Compensation
    ...a(['current', 'ctc'], f.currentCtc, 'facts'),
    ...a(['current', 'salary'], f.currentCtc, 'facts'),
    ...a(['expected', 'ctc'], f.expectedCtc, 'facts'),
    ...a(['expected', 'salary'], f.expectedCtc, 'facts'),
    // Location
    ...a(['current location'], f.currentLocation, 'facts'),
    ...a(['currently', 'located'], f.currentLocation, 'facts'),
    ...a(['preferred location'], f.currentLocation, 'facts'),
    ...a(['relocate'], f.willingToRelocate, 'facts'),
    ...a(['relocation'], f.willingToRelocate, 'facts'),
    // Current job
    ...a(['current company'], p.current_company),
    ...a(['current employer'], p.current_company),
    ...a(['current designation'], p.current_title),
    ...a(['current role'], p.current_title),
    // Education
    ...a(['highest', 'qualification'], edu?.degree === 'BTech' ? 'B.Tech' : edu?.degree),
    ...a(['degree'], edu?.degree === 'BTech' ? 'B.Tech' : edu?.degree),
    ...a(['graduation', 'year'], edu?.graduation_year),
    ...a(['year', 'passing'], edu?.graduation_year),
    ...a(['university'], edu?.institution),
    ...a(['college'], edu?.institution),
    // Links and contact
    ...a(['linkedin'], p.contact.linkedin),
    ...a(['github'], p.contact.github),
    ...a(['portfolio'], p.contact.github),
    ...a(['email'], p.contact.email),
    ...a(['phone'], p.contact.phone),
    ...a(['mobile'], p.contact.phone),
  ];
}

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9+.#]+/g, ' ').trim()} `;
const has = (q: string, m: string) => q.includes(norm(m)) || (m.length >= 4 && q.includes(m.toLowerCase()));

/**
 * The answer whose words all appear in the question, preferring the most specific match
 * ("notice period in days" → the days entry, not the general one). Null when nothing fits, when two entries are
 * equally specific but disagree, or when an experience question names a technology that is not one of your
 * strong skills (so "years of experience in Elixir" is never answered with your total years).
 */
export function matchAnswer(question: string, answers: Answer[], strongSkills?: string[]): string | null {
  const q = norm(question);
  if (/experience|years|worked|proficien/i.test(question)) {
    if (NEVER_CLAIM.some((s) => q.includes(norm(s)))) return null;
    const strong = new Set((strongSkills ?? []).map((s) => s.toLowerCase()));
    if (strongSkills && [...findSkills(question).keys()].some((s) => !strong.has(s.toLowerCase()))) return null;
  }
  const all = answers.filter((a) => a.answer.trim() && a.match.length && a.match.every((m) => has(q, m)));
  // Your own answers always beat the tool's (e.g. your "node → 3.7" over the profile's "node.js experience → 3").
  const yours = all.filter((a) => a.source === undefined || a.source === 'you');
  const hits = yours.length ? yours : all;
  if (!hits.length) return null;
  const best = Math.max(...hits.map((h) => h.match.join(' ').length));
  const top = [...new Set(hits.filter((h) => h.match.join(' ').length === best).map((h) => h.answer.trim()))];
  return top.length === 1 ? top[0] : null;
}

/**
 * Choose the option that fits an answer: exact text, then text containing it, then — for numbers — a range
 * like "2-4 years" or "3+ years" that contains the number. -1 when nothing fits.
 */
export function pickOption(options: string[], answer: string): number {
  const ans = answer.trim().toLowerCase();
  const clean = options.map((o) => o.trim().toLowerCase());
  let i = clean.findIndex((o) => o === ans);
  if (i >= 0) return i;
  i = clean.findIndex((o) => o.startsWith(ans) || (ans.length >= 3 && o.includes(ans)));
  if (i >= 0) return i;
  const n = Number(ans.match(/^\d+(\.\d+)?/)?.[0]);
  if (!Number.isFinite(n)) return -1;
  return clean.findIndex((o) => {
    const range = o.match(/(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)/);
    if (range) return n >= Number(range[1]) && n <= Number(range[2]);
    const plus = o.match(/(\d+(?:\.\d+)?)\s*\+/);
    if (plus) return n >= Number(plus[1]);
    const single = o.match(/^(\d+(?:\.\d+)?)\b/);
    return !!single && Number(single[1]) === n;
  });
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/**
 * Your answers file: bank answers, plus your own entries and edits (yours win when the match words are the same).
 * Writes the merged file back, so you can see and change every answer in one place.
 */
export function loadAnswers(profile: CandidateProfile, file = answersFile()): Answer[] {
  const mine = readJson<unknown>(file, []);
  const own = (Array.isArray(mine) ? mine : []).filter((a): a is Answer => !!a && Array.isArray(a.match) && typeof a.answer === 'string');
  const key = (a: Answer) => a.match.map((m) => m.toLowerCase()).join('|');
  const merged = new Map(buildAnswers(profile).map((a) => [key(a), a]));
  // Your entries win, except untouched empty template lines from the first version of this file.
  for (const a of own) if (a.answer.trim() || !merged.has(key(a))) merged.set(key(a), a);
  const out = [...merged.values()];
  writeJson(file, out);
  return out;
}

export interface UnansweredQuestion {
  question: string;
  site: string;
  job: string;
  firstSeen: string;
  times: number;
}

/** Remember a question nothing could answer, so `npm run answers` can show it and you answer it once. */
export function rememberQuestion(question: string, site: string, job: string, file = questionsFile()): void {
  const list = readJson<UnansweredQuestion[]>(file, []);
  const q = question.trim();
  if (!q) return;
  const found = list.find((x) => x.question.toLowerCase() === q.toLowerCase());
  if (found) found.times++;
  else list.push({ question: q, site, job, firstSeen: new Date().toISOString(), times: 1 });
  writeJson(file, list);
}

export function unansweredQuestions(answers: Answer[], strongSkills?: string[], file = questionsFile()): UnansweredQuestion[] {
  return readJson<UnansweredQuestion[]>(file, []).filter((q) => matchAnswer(q.question, answers, strongSkills) === null);
}

const STOP = new Set('a an the of in on for to with your you do does did is are was were have has how many much what which who when where why please kindly enter provide mention select specify share any and or if yes no can will would be been being this that these those it its as at by from our we us i my me about'.split(' '));

/** The words that identify a question, for matching it again later ("What is your notice period?" → notice, period). */
export function keywordsOf(question: string): string[] {
  const words = question.toLowerCase().replace(/[^a-z0-9+.#\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
  return [...new Set(words)].slice(0, 6);
}

/** Save your answer to a question, so it is answered automatically from now on; removes it from the unanswered list. */
export function saveAnswer(question: string, answer: string, file = answersFile(), qFile = questionsFile()): void {
  const list = readJson<Answer[]>(file, []);
  const match = keywordsOf(question);
  const key = match.join('|');
  const rest = list.filter((a) => a.match.map((m) => m.toLowerCase()).join('|') !== key);
  writeJson(file, [...rest, { match, answer: answer.trim(), source: 'you' }]);
  writeJson(qFile, readJson<UnansweredQuestion[]>(qFile, []).filter((q) => q.question.toLowerCase() !== question.trim().toLowerCase()));
}
