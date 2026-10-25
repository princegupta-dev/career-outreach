import type { ResumeChange } from '../resume/types';
import { checkBulletRewrite } from '../resume/truth-guard';
import { canonicalizeSkill, findSkills, getSkill } from '../skills/taxonomy';
import { applyEdits, itemSkills, LatexDoc, LatexEdit, latexEscape, maskComments, matchBrace, parseLatex, REORDERABLE_SECTION } from './latex';

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

export interface LatexSummary {
  text: string;
  /** Offsets of the paragraph text itself (without surrounding blank space). */
  start: number;
  end: number;
}

/**
 * The plain-text paragraph under a Summary / Profile / Objective heading, or null when there is none or it uses
 * LaTeX formatting (then it is left alone, like any non-plain bullet).
 */
export function latexSummary(doc: LatexDoc): LatexSummary | null {
  const sec = doc.sections.find((x) => /summary|profile|objective|about/i.test(x.title));
  if (!sec) return null;
  const masked = maskComments(doc.source);
  const cmd = /\\section\*?\s*(?:\[[^\]]*\])?\s*\{/.exec(masked.slice(sec.start, sec.end));
  if (!cmd) return null;
  const open = sec.start + cmd.index + cmd[0].length - 1;
  const close = matchBrace(masked, open);
  if (close < 0) return null;
  let from = close + 1;
  let raw = doc.source.slice(from, sec.end);
  // A common wrapper: \small{ …paragraph… }. Rewrite what is inside the braces.
  const wrap = /^\s*\\(?:small|footnotesize|normalsize)\s*\{/.exec(raw);
  if (wrap) {
    const wOpen = from + wrap[0].length - 1;
    const wClose = matchBrace(masked, wOpen);
    if (wClose < 0) return null;
    from = wOpen + 1;
    raw = doc.source.slice(from, wClose);
  }
  const lead = /^\s*/.exec(raw)![0].length;
  const body = raw.slice(lead).replace(/\s+$/, '');
  if (!body || /\\[A-Za-z]/.test(body) || /[{}$]/.test(body) || /^\s*%/m.test(body)) return null;
  return { text: body.replace(/\s+/g, ' '), start: from + lead, end: from + lead + body.length };
}

/** Where a confirmed skill belongs: the skills line whose items are mostly the same kind of skill. */
function bestSegment(doc: LatexDoc, skill: string): number {
  const cat = getSkill(skill)?.category;
  let best = -1;
  let bestScore = 0;
  doc.skillSegments.forEach((seg, i) => {
    const score = seg.items.filter((it) => {
      const def = getSkill(canonicalizeSkill(it.replace(/\s*\(.*\)$/, '')));
      return !!cat && def?.category === cat;
    }).length;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
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
  opts: { rewrites?: LatexRewrite[]; allowedSkills?: string[]; summaryRewrite?: string; addSkills?: string[]; summarySkills?: string[] } = {},
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

  // Skills the person confirmed they have (never chosen by the model). Skip any the resume already mentions.
  const already = new Set(findSkills(doc.source).keys());
  const added = new Map<number, string[]>();
  for (const raw of opts.addSkills ?? []) {
    const skill = canonicalizeSkill(raw);
    if (already.has(skill) || [...added.values()].some((l) => l.includes(skill))) continue;
    const at = bestSegment(doc, skill);
    if (at < 0) {
      rejected.push({ id: skill, reasons: ['No matching skills line in the resume to add it to'] });
      continue;
    }
    added.set(at, [...(added.get(at) ?? []), skill]);
    changes.push({ section: 'skills', change: `Added skill you confirmed: ${skill}`, reason: 'You said you have this skill and the job asks for it' });
  }

  doc.skillSegments.forEach((seg, si) => {
    const items = [...seg.items, ...(added.get(si) ?? [])];
    const idx = order(items, (s) => weights.get(canonicalizeSkill(s.replace(/\s*\(.*\)$/, ''))) ?? 0);
    const grew = items.length > seg.items.length;
    if (!grew && idx.every((v, i) => v === i)) return;
    const sep = doc.source.slice(seg.start, seg.end).includes(', ') ? ', ' : ',';
    edits.push({ start: seg.start, end: seg.end, replacement: keepSentenceCase(items, idx).join(sep) });
    if (idx.some((v, i) => v !== i)) changes.push({ section: 'skills', change: `Re-ordered skills: ${idx.slice(0, 4).map((i) => items[i]).join(', ')}…`, reason: 'JD-relevant skills first' });
  });

  // Summary paragraph, rephrased in the job's wording. Same truth checks as bullets, and it may not grow much.
  if (opts.summaryRewrite) {
    const sum = latexSummary(doc);
    if (sum) {
      const check = checkBulletRewrite(sum.text, opts.summaryRewrite, opts.summarySkills ?? []);
      if (opts.summaryRewrite.length > sum.text.length * 1.15 + 20) check.reasons.push('Summary is longer than the original');
      if (check.reasons.length) rejected.push({ id: 'summary', reasons: check.reasons });
      else if (opts.summaryRewrite.trim() !== sum.text) {
        edits.push({ start: sum.start, end: sum.end, replacement: latexEscape(opts.summaryRewrite.trim().replace(/\s+/g, ' ')) });
        changes.push({ section: 'summary', change: 'Rephrased the summary', reason: 'Aligned wording with the job description' });
      }
    }
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
