import * as path from 'path';
import { findSkills } from '../skills/taxonomy';

/**
 * Minimal, design-preserving LaTeX resume model.
 *
 * We never re-generate a resume. We locate three kinds of editable content in the
 * user's own .tex and leave every other byte untouched:
 *   1. bullet items inside "leaf" lists (itemize/enumerate or \xxxListStart … \xxxListEnd)
 *   2. comma-separated items in skills lines ("Languages: Java, Python, …")
 *   3. (optionally) the text of a plain bullet, replaced by a guarded rephrasing
 */

export interface LatexItem {
  /** Absolute offsets of the item in the source (core = without trailing whitespace). */
  start: number;
  end: number;
  core: string;
  trail: string;
  kind: 'macro' | 'item';
  macro?: string;
  /** Offsets of the editable text (macro's last argument, or content after \item). */
  textStart: number;
  textEnd: number;
  /** Plain-text rendering of the item. */
  text: string;
  /** True if the editable text has no LaTeX commands other than escaped characters. */
  simple: boolean;
}

export interface LatexList {
  start: number;
  end: number;
  bodyStart: number;
  bodyEnd: number;
  section: string;
  items: LatexItem[];
}

export interface LatexSection {
  title: string;
  start: number;
  end: number;
}

export interface SkillSegment {
  section: string;
  start: number;
  end: number;
  items: string[];
}

export interface LatexDoc {
  source: string;
  bodyStart: number;
  bodyEnd: number;
  sections: LatexSection[];
  lists: LatexList[];
  skillSegments: SkillSegment[];
}

export class LatexParseError extends Error {}

/** Replace comment text with spaces (same length) so offsets stay valid. */
export function maskComments(src: string): string {
  const out = src.split('');
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '%' && !isEscaped(src, i)) {
      let j = i;
      while (j < src.length && src[j] !== '\n') out[j++] = ' ';
      i = j;
    }
  }
  return out.join('');
}

function isEscaped(src: string, i: number): boolean {
  let n = 0;
  for (let k = i - 1; k >= 0 && src[k] === '\\'; k--) n++;
  return n % 2 === 1;
}

/** Index of the brace matching the '{' at `open` (in comment-masked text), or -1. */
export function matchBrace(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if ((c === '{' || c === '}') && isEscaped(masked, i)) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const SIMPLE_TEXT = /^(?:[^\\]|\\[%&$#_{}])*$/;

/** LaTeX → readable plain text (for scoring, AI prompts and previews). */
export function latexToText(s: string): string {
  let t = maskComments(s);
  t = t.replace(/\\href\s*\{[^{}]*\}\s*\{([^{}]*)\}/g, '$1');
  let prev = '';
  while (prev !== t) {
    prev = t;
    t = t.replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g, '$1');
  }
  return t
    .replace(/\\\\/g, ' ')
    .replace(/\\([%&$#_{}])/g, '$1')
    .replace(/\\[a-zA-Z]+\*?/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')
    .replace(/---/g, '—')
    .replace(/--/g, '–')
    .replace(/\s+/g, ' ')
    .trim();
}

export function latexEscape(text: string): string {
  return text
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([%&$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

const LIST_OPEN = /\\begin\s*\{(itemize|enumerate)\}|\\(\w+ListStart)\b/g;
const LIST_CLOSE = /\\end\s*\{(itemize|enumerate)\}|\\(\w+ListEnd)\b/g;
const ITEM_START = /\\item\b|\\([A-Za-z]*[Ii]tem[A-Za-z]*)\s*(?=\{)/g;

interface Token {
  index: number;
  length: number;
  open: boolean;
}

/** Parse the document body into sections, leaf lists (bullets) and skills segments. */
export function parseLatex(source: string): LatexDoc {
  if (!/\\documentclass/.test(source)) throw new LatexParseError('Not a LaTeX document (no \\documentclass).');
  const masked = maskComments(source);
  const begin = /\\begin\s*\{document\}/.exec(masked);
  const endDoc = /\\end\s*\{document\}/.exec(masked);
  if (!begin || !endDoc) throw new LatexParseError('Missing \\begin{document} / \\end{document}.');
  const bodyStart = begin.index + begin[0].length;
  const bodyEnd = endDoc.index;
  const body = masked.slice(0, bodyEnd);

  // Sections.
  const sections: LatexSection[] = [];
  const secRe = /\\section\*?\s*\{/g;
  secRe.lastIndex = bodyStart;
  let m: RegExpExecArray | null;
  while ((m = secRe.exec(body))) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(masked, open);
    if (close < 0) continue;
    sections.push({ title: latexToText(source.slice(open + 1, close)), start: m.index, end: bodyEnd });
  }
  for (let i = 0; i < sections.length - 1; i++) sections[i].end = sections[i + 1].start;
  const sectionAt = (pos: number) => [...sections].reverse().find((s) => s.start <= pos)?.title ?? '';

  // Lists (stack-matched), keep leaf lists only.
  const tokens: Token[] = [];
  for (const [re, open] of [
    [LIST_OPEN, true],
    [LIST_CLOSE, false],
  ] as const) {
    re.lastIndex = bodyStart;
    while ((m = re.exec(body))) tokens.push({ index: m.index, length: m[0].length, open });
  }
  tokens.sort((a, b) => a.index - b.index);
  const stack: Array<{ tok: Token; hasChild: boolean }> = [];
  const lists: LatexList[] = [];
  for (const tok of tokens) {
    if (tok.open) {
      if (stack.length) stack[stack.length - 1].hasChild = true;
      stack.push({ tok, hasChild: false });
    } else {
      const top = stack.pop();
      if (!top) continue;
      if (top.hasChild) continue;
      const bStart = top.tok.index + top.tok.length;
      lists.push({ start: top.tok.index, end: tok.index + tok.length, bodyStart: bStart, bodyEnd: tok.index, section: sectionAt(top.tok.index), items: parseItems(source, masked, bStart, tok.index) });
    }
  }
  lists.sort((a, b) => a.start - b.start);

  // Skills: comma-separated runs of plain text, after a colon, in skills-like sections.
  const skillSegments: SkillSegment[] = [];
  for (const sec of sections.filter((s) => /skill|technolog|tools|stack|expertise/i.test(s.title))) {
    const segRe = /[^{}\\\n%]+/g;
    const text = masked.slice(sec.start, sec.end);
    while ((m = segRe.exec(text))) {
      const raw = m[0];
      const absStart = sec.start + m.index;
      const lead = /^\s*:?\s*/.exec(raw)![0];
      // A trailing clause after ";" ("…, automation; exploring RAG") stays where it is.
      const content = raw.slice(lead.length).slice(0, topLevelIndex(raw.slice(lead.length), ';')).replace(/\s+$/, '');
      const before = masked.slice(Math.max(sec.start, absStart - 40), absStart + lead.length);
      if (!before.includes(':')) continue;
      const items = splitTopLevel(content, ',').map((x) => x.trim());
      if (items.length < 2 || items.some((x) => !x)) continue;
      skillSegments.push({ section: sec.title, start: absStart + lead.length, end: absStart + lead.length + content.length, items });
    }
  }

  return { source, bodyStart, bodyEnd, sections, lists, skillSegments };
}

/** Index of the first `ch` outside parentheses/brackets (or the string length). */
function topLevelIndex(s: string, ch: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(' || s[i] === '[') depth++;
    else if ((s[i] === ')' || s[i] === ']') && depth > 0) depth--;
    else if (s[i] === ch && depth === 0) return i;
  }
  return s.length;
}

/** Split on `sep` outside parentheses: "AWS (EC2, S3), Docker" → ["AWS (EC2, S3)", " Docker"]. */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let rest = s;
  for (let i = topLevelIndex(rest, sep); i < rest.length; i = topLevelIndex(rest, sep)) {
    out.push(rest.slice(0, i));
    rest = rest.slice(i + 1);
  }
  out.push(rest);
  return out;
}

function parseItems(source: string, masked: string, bodyStart: number, bodyEnd: number): LatexItem[] {
  const starts: Array<{ index: number; kind: 'macro' | 'item'; macro?: string; len: number }> = [];
  const re = new RegExp(ITEM_START.source, 'g');
  re.lastIndex = bodyStart;
  let m: RegExpExecArray | null;
  const region = masked.slice(0, bodyEnd);
  while ((m = re.exec(region))) {
    if (m[1] && /List(Start|End)$/.test(m[1])) continue;
    // Skip \item occurrences nested inside a macro argument of a previous item.
    starts.push({ index: m.index, kind: m[1] ? 'macro' : 'item', macro: m[1], len: m[0].length });
  }
  const items: LatexItem[] = [];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    let rawEnd = i + 1 < starts.length ? starts[i + 1].index : bodyEnd;
    let textStart: number;
    let textEnd: number;
    if (s.kind === 'macro') {
      // Consume all brace arguments; the last one is the editable text.
      let pos = s.index + s.len;
      let lastOpen = -1;
      let lastClose = -1;
      while (pos < bodyEnd) {
        while (pos < bodyEnd && /\s/.test(masked[pos])) pos++;
        if (masked[pos] !== '{') break;
        const close = matchBrace(masked, pos);
        if (close < 0) break;
        lastOpen = pos;
        lastClose = close;
        pos = close + 1;
      }
      if (lastOpen < 0) continue;
      textStart = lastOpen + 1;
      textEnd = lastClose;
      // Items nested inside this macro's arguments belong to it.
      while (i + 1 < starts.length && starts[i + 1].index < lastClose) i++;
      rawEnd = i + 1 < starts.length ? starts[i + 1].index : bodyEnd;
    } else {
      textStart = s.index + s.len;
      textEnd = rawEnd;
      while (textEnd > textStart && /\s/.test(source[textEnd - 1])) textEnd--;
      while (textStart < textEnd && /\s/.test(source[textStart])) textStart++;
    }
    const raw = source.slice(s.index, rawEnd);
    const core = raw.replace(/\s+$/, '');
    const editable = source.slice(textStart, textEnd);
    items.push({
      start: s.index,
      end: rawEnd,
      core,
      trail: raw.slice(core.length),
      kind: s.kind,
      macro: s.macro,
      textStart,
      textEnd,
      text: latexToText(editable),
      simple: SIMPLE_TEXT.test(editable) && !maskComments(editable).includes('%'),
    });
  }
  return items;
}

/** Extra files uploaded with a .tex (kept for reference; the PDF is drawn from the resume content, not by running LaTeX). */
const ALLOWED_ASSET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.(cls|sty|bst|bib|png|jpe?g|pdf|otf|ttf|tex|def|cfg|fd)$/i;

export function sanitizeAssetName(name: string): string | null {
  const base = path.basename(name);
  return ALLOWED_ASSET.test(base) ? base : null;
}

/** Basic safety + sanity checks for an uploaded resume. */
export function validateLatexUpload(source: string): string[] {
  const problems: string[] = [];
  if (source.length > 300_000) problems.push('The .tex file is too large (max 300 KB).');
  if (!/\\documentclass/.test(source)) problems.push('Missing \\documentclass.');
  if (!/\\begin\s*\{document\}/.test(source)) problems.push('Missing \\begin{document}.');
  const masked = maskComments(source);
  if (/\\(immediate\s*)?\\?write18|\\input\s*\{?\s*\|/.test(masked)) problems.push('Shell-escape commands (\\write18 / piped \\input) are not allowed.');
  return problems;
}

/** Bullet items of experience/project/achievement sections (the content that may be re-ordered). */
export const REORDERABLE_SECTION = /experience|employment|work|project|professional|internship|career|challenge|achievement|highlight/i;

export interface LatexEdit {
  start: number;
  end: number;
  replacement: string;
}

/** Apply non-overlapping edits (any order) to the source. */
export function applyEdits(source: string, edits: LatexEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = source;
  let lastStart = Infinity;
  for (const e of sorted) {
    if (e.end > lastStart) throw new Error('Overlapping LaTeX edits');
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
    lastStart = e.start;
  }
  return out;
}

/** Skills mentioned in an item (for relevance scoring). */
export function itemSkills(item: { text: string }): string[] {
  return [...findSkills(item.text).keys()];
}

/** Plain-text outline of the resume, in document order (used to derive structured data). */
export function latexOutline(doc: LatexDoc): string {
  const lines: string[] = [];
  for (const sec of doc.sections) {
    lines.push('', sec.title);
    const lists = doc.lists.filter((l) => l.start >= sec.start && l.end <= sec.end);
    const listText = lists.flatMap((l) => l.items.map((i) => `• ${i.text}`));
    // Non-list text in the section (headings like company/title/dates).
    let cursor = sec.start;
    const chunks: string[] = [];
    for (const l of lists) {
      chunks.push(doc.source.slice(cursor, l.start));
      cursor = l.end;
    }
    chunks.push(doc.source.slice(cursor, sec.end));
    const headerText = chunks
      .map((c) => c.replace(/\\section\*?\s*\{[^}]*\}/, ''))
      .map(latexToText)
      .filter((t) => t.length > 1);
    lines.push(...headerText, ...listText);
  }
  return lines.join('\n');
}

/**
 * The resume's readable body text: everything from the first real \section, without the preamble and the header
 * (name, contact line, and link labels like "GitHub", which say nothing about skills).
 */
export function resumeBodyText(source: string): string {
  const doc = source.indexOf('\\begin{document}');
  const first = source.indexOf('\\section', doc < 0 ? 0 : doc);
  return latexToText(source.slice(first < 0 ? 0 : first));
}
