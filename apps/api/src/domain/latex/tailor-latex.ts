import type { ResumeChange } from '../resume/types';
import { checkBulletRewrite } from '../resume/truth-guard';
import { canonicalizeSkill } from '../skills/taxonomy';
import { applyEdits, itemSkills, LatexDoc, LatexEdit, latexEscape, parseLatex, REORDERABLE_SECTION } from './latex';

export interface LatexBullet {
  id: string;
  section: string;
  text: string;
  simple: boolean;
  skills: string[];
  relevance: number;
}

export interface LatexRewrite {
  id: string;
  text: string;
  reason?: string;
}

export interface LatexTailorResult {
  latex: string;
  changes: ResumeChange[];
  bullets: LatexBullet[];
  /** Rewrites that were rejected by the truth guard (with reasons). */
  rejected: Array<{ id: string; reasons: string[] }>;
}

function relevance(skills: string[], weights: Map<string, number>): number {
  return skills.reduce((a, s) => a + (weights.get(s) ?? 0), 0);
}

/** Stable sort indices by descending score. */
function order<T>(items: T[], score: (t: T) => number): number[] {
  return items
    .map((it, i) => ({ i, s: score(it) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.i);
}

/** All bullets of reorderable sections, with stable ids ("L<list>-<item>"). */
export function latexBullets(doc: LatexDoc, weights: Map<string, number>): LatexBullet[] {
  const out: LatexBullet[] = [];
  doc.lists.forEach((list, li) => {
    if (!REORDERABLE_SECTION.test(list.section)) return;
    list.items.forEach((item, ii) => {
      const skills = itemSkills(item);
      out.push({ id: `L${li}-${ii}`, section: list.section, text: item.text, simple: item.simple, skills, relevance: relevance(skills, weights) });
    });
  });
  return out;
}

/**
 * Tailor a LaTeX resume for a job WITHOUT changing its design:
 * re-order bullets within each experience/project list and skills within each
 * skills line, and optionally apply guarded rephrasings of plain bullets.
 * Nothing is added or removed.
 */
export function tailorLatex(
  source: string,
  weights: Map<string, number>,
  opts: { rewrites?: LatexRewrite[]; allowedSkills?: string[] } = {},
): LatexTailorResult {
  const doc = parseLatex(source);
  const edits: LatexEdit[] = [];
  const changes: ResumeChange[] = [];
  const rejected: LatexTailorResult['rejected'] = [];
  const rewrites = new Map((opts.rewrites ?? []).map((r) => [r.id, r]));
  const bullets = latexBullets(doc, weights);

  doc.lists.forEach((list, li) => {
    if (!REORDERABLE_SECTION.test(list.section) || !list.items.length) return;
    // Per-item text (possibly rephrased).
    const cores = list.items.map((item, ii) => {
      const rw = rewrites.get(`L${li}-${ii}`);
      if (!rw) return item.core;
      if (!item.simple) {
        rejected.push({ id: `L${li}-${ii}`, reasons: ['Bullet contains LaTeX formatting; kept verbatim'] });
        return item.core;
      }
      const check = checkBulletRewrite(item.text, rw.text, opts.allowedSkills ?? []);
      if (!check.ok) {
        rejected.push({ id: `L${li}-${ii}`, reasons: check.reasons });
        return item.core;
      }
      changes.push({ section: 'bullet', change: `Rephrased: "${item.text.slice(0, 70)}…"`, reason: rw.reason ?? 'Aligned wording with the job description' });
      const relStart = item.textStart - item.start;
      const relEnd = item.textEnd - item.start;
      const lead = item.kind === 'item' ? ' ' : '';
      return (item.core.slice(0, relStart) + lead + latexEscape(rw.text.trim()) + item.core.slice(relEnd)).replace(/^\\item\s\s+/, '\\item ');
    });
    const idx = list.items.length > 1 ? order(list.items, (it) => relevance(itemSkills(it), weights)) : [0];
    const moved = idx.some((v, i) => v !== i);
    const changedText = cores.some((c, i) => c !== list.items[i].core);
    if (!moved && !changedText) return;
    const firstStart = list.items[0].start;
    const lastEnd = list.items[list.items.length - 1].end;
    const replacement = idx.map((orig, pos) => cores[orig] + list.items[pos].trail).join('');
    edits.push({ start: firstStart, end: lastEnd, replacement });
    if (moved) changes.push({ section: 'experience', change: `Re-ordered ${list.items.length} bullets in "${list.section}"`, reason: `Most relevant first: "${list.items[idx[0]].text.slice(0, 60)}…"` });
  });

  for (const seg of doc.skillSegments) {
    const idx = order(seg.items, (s) => weights.get(canonicalizeSkill(s.replace(/\s*\(.*\)$/, ''))) ?? 0);
    if (idx.every((v, i) => v === i)) continue;
    const sep = doc.source.slice(seg.start, seg.end).includes(', ') ? ', ' : ',';
    edits.push({ start: seg.start, end: seg.end, replacement: keepSentenceCase(seg.items, idx).join(sep) });
    changes.push({ section: 'skills', change: `Re-ordered skills: ${idx.slice(0, 4).map((i) => seg.items[i]).join(', ')}…`, reason: 'JD-relevant skills first (nothing added or removed)' });
  }

  for (const id of rewrites.keys()) {
    if (!bullets.some((b) => b.id === id)) rejected.push({ id, reasons: ['Unknown bullet id'] });
  }

  return { latex: edits.length ? applyEdits(source, edits) : source, changes, bullets, rejected };
}

/**
 * Re-order a sentence-case list ("System design, distributed systems") without leaving a
 * capital mid-line: the new first phrase gets the capital, the old one loses it.
 * Proper nouns / acronyms ("PostgreSQL", "AWS") are never touched.
 */
function keepSentenceCase(items: string[], idx: number[]): string[] {
  const out = idx.map((i) => items[i]);
  const sentence = (s: string) => /^[A-Z][a-z]+(\s|$)/.test(s);
  const lower = (s: string) => /^[a-z]+(\s|$)/.test(s);
  if (idx[0] === 0 || !sentence(items[0]) || !lower(items[idx[0]])) return out;
  return out.map((s, pos) => (pos === 0 ? s[0].toUpperCase() + s.slice(1) : idx[pos] === 0 ? s[0].toLowerCase() + s.slice(1) : s));
}

/** Line diff (LCS) for showing what changed between the master and tailored .tex. */
export function lineDiff(a: string, b: string): Array<{ type: 'same' | 'add' | 'del'; line: string }> {
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Array<{ type: 'same' | 'add' | 'del'; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ type: 'same', line: x[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ type: 'del', line: x[i++] });
    else out.push({ type: 'add', line: y[j++] });
  }
  while (i < n) out.push({ type: 'del', line: x[i++] });
  while (j < m) out.push({ type: 'add', line: y[j++] });
  return out;
}
