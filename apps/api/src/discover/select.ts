import * as fs from 'fs';
import * as path from 'path';
import { normalizeCompanyName } from '../domain/dedupe';
import type { FoundJob } from '../search';

/**
 * The "discover" workflow's rules: which jobs are genuinely good enough to show, in what order, and a permanent
 * history so a job is never shown twice (across sources and across days). Pure functions except the history file.
 */

export const DAILY_TARGET = 50;

/** Priority 0: the roles you asked for first. Priority 1: general software / SDE / API roles. Priority 2: full-stack. */
const PRIORITY_0 = /\bback[\s-]?end\b|\bnode(\.?js)?\b|\bnest\.?js\b|\btypescript\b|\bplatform (engineer|developer)\b|\bai backend\b|backend\s*(\+|and|&)\s*ai/i;
const PRIORITY_1 = /\bsoftware (engineer|developer|development engineer)\b|\bsde\b|\bapi (engineer|developer)\b|\bserver[\s-]?side\b|\bmember of technical staff\b/i;
const PRIORITY_2 = /\bfull[\s-]?stack\b/i;
/** Never a fit, whatever the score: other disciplines and levels the profile excludes. */
const NOT_A_FIT = /react native|\bandroid\b|\bios\b|flutter|front[\s-]?end|\bui\b|machine learning|\bml engineer|data (engineer|scientist|analyst)|devops|\bsre\b|\bqa\b|\btest\b|\bsdet\b|\bintern\b|\bjunior\b|\bfresher\b|manager|\bdirector\b|\bhead of\b|\bstaff\b|\bprincipal\b|\barchitect\b/i;
const FAMILIES = ['backend', 'platform', 'ai_backend', 'software', 'fullstack'];

export function priorityOf(title: string): 0 | 1 | 2 | null {
  // "Member of Technical Staff" is an ordinary engineering title, not the staff level.
  if (NOT_A_FIT.test(title.replace(/member of (the )?technical staff/gi, 'mts'))) return null;
  if (PRIORITY_0.test(title)) return 0;
  if (PRIORITY_1.test(title)) return 1;
  if (PRIORITY_2.test(title)) return 2;
  return null;
}

export interface QualityRules {
  minScore: number;
  /** Your years of experience; jobs asking for much more are not a match. */
  experienceYears: number;
}

/** Why a job does not qualify, or null when it does. Every rule is about fit; none is relaxed to reach a number. */
export function rejectReason(j: FoundJob, r: QualityRules): string | null {
  if (priorityOf(j.title) === null) return 'role:not-a-priority-role';
  if (j.roleFamily && !FAMILIES.includes(j.roleFamily)) return `role:family-${j.roleFamily}`;
  if (j.score < r.minScore) return 'score:below-minimum';
  if (j.recommendation === 'SKIP' || j.recommendation === 'LOW_PRIORITY') return 'score:low-recommendation';
  if (j.flags.includes('location:requires-relocation')) return 'location:not-open-to-india';
  if (j.minYears != null && j.minYears > r.experienceYears + 2) return 'experience:asks-for-much-more';
  if (j.seniority && ['staff', 'principal', 'manager', 'intern', 'junior'].includes(j.seniority)) return `seniority:${j.seniority}`;
  return null;
}

/** The same job on two sites (or posted twice) has the same company and title. Locations are written too differently to compare. */
export function sameJobKey(company: string, title: string): string {
  const t = title
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(sr|snr)\b\.?/g, 'senior')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim();
  return `${normalizeCompanyName(company)}|${t}`;
}

export interface HistoryEntry {
  key: string;
  shownOn: string; // YYYY-MM-DD
  source: string;
  title: string;
  company: string;
  score: number;
}
export interface History {
  jobs: Record<string, HistoryEntry>;
}

export const historyFile = () => process.env.JOB_HUNTER_HISTORY ?? path.resolve(__dirname, '../../.cache/history.json');

export function loadHistory(file = historyFile()): History {
  try {
    const h = JSON.parse(fs.readFileSync(file, 'utf8')) as History;
    return { jobs: h.jobs ?? {} };
  } catch {
    return { jobs: {} };
  }
}

/** Written via a temp file + rename, so a crash never leaves it half-written. Never pruned: it is the permanent record. */
export function saveHistory(h: History, file = historyFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(h));
  fs.renameSync(tmp, file);
}

export interface Selection {
  picked: FoundJob[];
  qualified: number;
  alreadyShown: number;
  rejected: Record<string, number>;
}

/**
 * Today's list: qualified jobs never shown before (by id or by company + title), one per job across sources,
 * best first (priority role, then score, then newest), at most `target`. Fewer when fewer qualify.
 */
export function selectToday(jobs: FoundJob[], history: History, rules: QualityRules, target = DAILY_TARGET): Selection {
  const rejected: Record<string, number> = {};
  const shownKeys = new Set(Object.values(history.jobs).map((e) => e.key));
  const qualified: FoundJob[] = [];
  for (const j of jobs) {
    const why = rejectReason(j, rules);
    if (why) rejected[why] = (rejected[why] ?? 0) + 1;
    else qualified.push(j);
  }
  const order = (a: FoundJob, b: FoundJob) =>
    priorityOf(a.title)! - priorityOf(b.title)! || b.score - a.score || (b.postedAt ?? '').localeCompare(a.postedAt ?? '');
  const today = new Set<string>();
  let alreadyShown = 0;
  const picked: FoundJob[] = [];
  for (const j of [...qualified].sort(order)) {
    const key = sameJobKey(j.company, j.title);
    if (history.jobs[j.id] || shownKeys.has(key)) {
      alreadyShown++;
      continue;
    }
    if (today.has(key)) continue; // same job from a second source today: keep the better-ranked one
    today.add(key);
    if (picked.length < target) picked.push(j);
  }
  return { picked, qualified: qualified.length, alreadyShown, rejected };
}

export function remember(history: History, jobs: FoundJob[], day: string): History {
  const next = { jobs: { ...history.jobs } };
  for (const j of jobs) next.jobs[j.id] = { key: sameJobKey(j.company, j.title), shownOn: day, source: j.source, title: j.title, company: j.company, score: j.score };
  return next;
}

/** Jobs shown per day, per source, newest day first (for the dashboard's daily statistics). */
export function dailyStats(h: History): Array<{ day: string; total: number; bySource: Record<string, number>; avgScore: number }> {
  const days = new Map<string, HistoryEntry[]>();
  for (const e of Object.values(h.jobs)) days.set(e.shownOn, [...(days.get(e.shownOn) ?? []), e]);
  return [...days.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, list]) => {
      const bySource: Record<string, number> = {};
      for (const e of list) bySource[e.source] = (bySource[e.source] ?? 0) + 1;
      return { day, total: list.length, bySource, avgScore: Math.round(list.reduce((s, e) => s + e.score, 0) / list.length) };
    });
}
