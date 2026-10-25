import { matchBrace, maskComments } from '../latex/latex';
import type { ResumeData } from './types';

/**
 * A resume as content, independent of how it is drawn. The LaTeX (or structured) master is turned into this,
 * and the HTML template draws it. Re-ordering for a job happens BEFORE this step (tailor-latex / tailor),
 * so this module only reads what it is given and never adds, drops or rewrites facts.
 */

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** Monospace (e.g. \texttt{CROSSSLOT}). */
  code?: boolean;
  href?: string;
}
export type Inline = Run[];

export type Block =
  | { type: 'paragraph'; content: Inline }
  | { type: 'skills'; rows: Array<{ label: Inline; items: Inline }> }
  | { type: 'entry'; title: Inline; aside: Inline; subtitle: Inline; subAside: Inline; bullets: Inline[] }
  | { type: 'project'; title: Inline; tech: Inline; bullets: Inline[] }
  | { type: 'bullets'; items: Inline[] };

export interface ResumeSection {
  title: string;
  blocks: Block[];
}

export interface ResumeDocument {
  name: string;
  /** Lines under the name (headline, contact line…), each already styled and linked. */
  header: Inline[];
  sections: ResumeSection[];
}

export class ResumeDocumentError extends Error {}

// ─── Inline LaTeX → runs ─────────────────────────────────────────────────────

const SYMBOLS: Record<string, string> = { '&': '&', '%': '%', $: '$', '#': '#', _: '_', '{': '{', '}': '}', ',': ' ', ' ': ' ', ';': ' ', '!': '', '/': '' };
const IGNORED_SIZE = /^(tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge|bfseries|itshape|scshape|raggedright|centering|noindent|vspace\*?|hspace\*?|medskip|smallskip|bigskip|hfill|par|relax)$/;

interface Style {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  href?: string;
}

function push(out: Run[], text: string, style: Style): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && !!last.bold === !!style.bold && !!last.italic === !!style.italic && !!last.code === !!style.code && last.href === style.href) last.text += text;
  else out.push({ text, ...(style.bold ? { bold: true } : {}), ...(style.italic ? { italic: true } : {}), ...(style.code ? { code: true } : {}), ...(style.href ? { href: style.href } : {}) });
}

/** First brace group starting at or after `i` (skipping whitespace): its inner text and the index after it. */
function braceArg(s: string, i: number): { arg: string; next: number } | null {
  let k = i;
  while (k < s.length && /\s/.test(s[k])) k++;
  if (s[k] !== '{') return null;
  const end = matchBrace(s, k);
  if (end < 0) return null;
  return { arg: s.slice(k + 1, end), next: end + 1 };
}

function walk(s: string, style: Style, out: Run[]): void {
  let i = 0;
  let buf = '';
  const flush = () => {
    push(out, buf, style);
    buf = '';
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const m = /^\\([a-zA-Z]+)\*?/.exec(s.slice(i));
      if (!m) {
        const sym = s[i + 1];
        if (sym === '\\') {
          buf += ' '; // line break inside inline text
          i += 2;
          while (s[i] === ' ') i++;
        } else if (sym !== undefined && sym in SYMBOLS) {
          buf += SYMBOLS[sym];
          i += 2;
        } else {
          i += 2;
        }
        continue;
      }
      const name = m[1];
      i += m[0].length;
      if (name === 'href') {
        const url = braceArg(s, i);
        const label = url ? braceArg(s, url.next) : null;
        if (url && label) {
          flush();
          walk(label.arg, { ...style, href: url.arg.trim() }, out);
          i = label.next;
        }
        continue;
      }
      const wrapStyle: Style | null =
        name === 'textbf' || name === 'bf' ? { ...style, bold: true } : name === 'textit' || name === 'emph' || name === 'it' || name === 'textsl' ? { ...style, italic: true } : name === 'texttt' || name === 'verb' ? { ...style, code: true } : name === 'textsc' || name === 'underline' || name === 'text' || name === 'textrm' || name === 'textsf' || name === 'mbox' ? { ...style } : null;
      if (wrapStyle) {
        const a = braceArg(s, i);
        if (a) {
          flush();
          walk(a.arg, wrapStyle, out);
          i = a.next;
        }
        continue;
      }
      if (name === 'textbar') {
        buf += '|';
        continue;
      }
      if (name === 'textbackslash') {
        buf += '\\';
        continue;
      }
      if (name === 'LaTeX' || name === 'TeX') {
        buf += name;
        continue;
      }
      if (IGNORED_SIZE.test(name)) {
        // `\small{…}` keeps its content; bare switches and spacing commands vanish (spacing args too).
        if (/^(vspace|hspace)/.test(name)) {
          const a = braceArg(s, i);
          if (a) i = a.next;
        } else {
          const a = braceArg(s, i);
          if (a && s.slice(i, i + 1) !== '\n') {
            flush();
            walk(a.arg, style, out);
            i = a.next;
          }
        }
        continue;
      }
      // Unknown command: keep its text argument, drop the command itself.
      const a = braceArg(s, i);
      if (a) {
        flush();
        walk(a.arg, style, out);
        i = a.next;
      }
      continue;
    }
    if (c === '$') {
      if (s.startsWith('$|$', i)) {
        buf += '|';
        i += 3;
      } else {
        i++; // inline math marker: keep the symbols between, drop the dollars
      }
      continue;
    }
    if (c === '{' || c === '}') {
      i++;
      continue;
    }
    if (c === '~') {
      buf += ' ';
      i++;
      continue;
    }
    if (c === '-' && s.startsWith('---', i)) {
      buf += '—';
      i += 3;
      continue;
    }
    if (c === '-' && s.startsWith('--', i)) {
      buf += '–';
      i += 2;
      continue;
    }
    if (c === '`' || c === "'") {
      buf += c === '`' && s[i + 1] === '`' ? '“' : c === "'" && s[i + 1] === "'" ? '”' : c === '`' ? '‘' : '’';
      i += c === '`' && s[i + 1] === '`' ? 2 : c === "'" && s[i + 1] === "'" ? 2 : 1;
      continue;
    }
    buf += c;
    i++;
  }
  flush();
}

/** Inline LaTeX (bold, italics, \texttt, \href, escapes, dashes) → styled runs with whitespace tidied. */
export function parseInline(raw: string): Inline {
  const runs: Run[] = [];
  walk(maskComments(raw), {}, runs);
  // Collapse whitespace (but keep non-breaking spaces) and trim the ends.
  for (const r of runs) r.text = r.text.replace(/[ \t\r\n]+/g, ' ');
  while (runs.length && !runs[0].text.trim()) runs.shift();
  while (runs.length && !runs[runs.length - 1].text.trim()) runs.pop();
  if (runs.length) {
    runs[0].text = runs[0].text.replace(/^ /, '');
    runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/ $/, '');
  }
  return runs.filter((r) => r.text.length);
}

export const inlineText = (i: Inline): string => i.map((r) => r.text).join('');

// ─── Block structure ─────────────────────────────────────────────────────────

/** Arity of the macros this resume format uses (from the user's \newcommand lines, with sensible defaults). */
function macroArities(preamble: string): Map<string, number> {
  const m = new Map<string, number>([
    ['itemx', 1],
    ['resumeItem', 1],
    ['subheading', 4],
    ['resumeSubheading', 4],
    ['project', 2],
    ['resumeProjectHeading', 2],
  ]);
  for (const d of maskComments(preamble).matchAll(/\\(?:re)?newcommand\s*\{?\\([a-zA-Z]+)\}?\s*(?:\[(\d)\])?/g)) m.set(d[1], Number(d[2] ?? 0));
  return m;
}

const BULLET_MACROS = new Set(['itemx', 'resumeItem', 'resumeSubItem']);
const ENTRY_MACROS = new Set(['subheading', 'resumeSubheading']);
const PROJECT_MACROS = new Set(['project', 'resumeProjectHeading']);

type Node = { t: 'cmd'; name: string; args: string[] } | { t: 'env'; name: string; body: string } | { t: 'item'; body: string } | { t: 'text'; text: string };

/** Split a LaTeX fragment into the structural pieces we care about; everything else is text. */
function nodes(src: string, arities: Map<string, number>): Node[] {
  const out: Node[] = [];
  let i = 0;
  let text = '';
  const flush = () => {
    if (text.trim()) out.push({ t: 'text', text });
    text = '';
  };
  while (i < src.length) {
    if (src.startsWith('\\begin{', i)) {
      const nm = /^\\begin\{([a-zA-Z*]+)\}(\[[^\]]*\])?/.exec(src.slice(i));
      if (nm) {
        const bodyStart = i + nm[0].length;
        let depth = 1;
        let k = bodyStart;
        const re = new RegExp(`\\\\(begin|end)\\{${nm[1].replace('*', '\\*')}\\}`, 'g');
        re.lastIndex = bodyStart;
        let hit: RegExpExecArray | null;
        let end = -1;
        while ((hit = re.exec(src))) {
          depth += hit[1] === 'begin' ? 1 : -1;
          if (depth === 0) {
            end = hit.index;
            k = hit.index + hit[0].length;
            break;
          }
        }
        if (end >= 0) {
          flush();
          out.push({ t: 'env', name: nm[1], body: src.slice(bodyStart, end) });
          i = k;
          continue;
        }
      }
    }
    if (src[i] === '\\') {
      const m = /^\\([a-zA-Z]+)\*?/.exec(src.slice(i));
      if (m) {
        const name = m[1];
        if (name === 'item') {
          // \item runs until the next \item / \end of this level.
          flush();
          let j = i + m[0].length;
          let depth = 0;
          const start = j;
          for (; j < src.length; j++) {
            if (src.startsWith('\\begin{', j)) depth++;
            else if (src.startsWith('\\end{', j)) {
              if (depth === 0) break;
              depth--;
            } else if (depth === 0 && /^\\(item|subheading|resumeSubheading|project|resumeProjectHeading|itemx|resumeItem)\b/.test(src.slice(j, j + 24)) && j > start) break;
          }
          out.push({ t: 'item', body: src.slice(start, j) });
          i = j;
          continue;
        }
        if (arities.has(name) && arities.get(name)! > 0) {
          let j = i + m[0].length;
          const args: string[] = [];
          for (let a = 0; a < arities.get(name)!; a++) {
            const g = braceArg(src, j);
            if (!g) break;
            args.push(g.arg);
            j = g.next;
          }
          flush();
          out.push({ t: 'cmd', name, args });
          i = j;
          continue;
        }
      }
    }
    text += src[i];
    i++;
  }
  flush();
  return out;
}

/** "\textbf{Label:} a, b\\ \textbf{Other:} c" → one row per label. */
function skillRows(body: string): Array<{ label: Inline; items: Inline }> {
  const rows: Array<{ label: Inline; items: Inline }> = [];
  for (const line of body.split(/\\\\(?![a-zA-Z])/)) {
    if (!line.trim()) continue;
    const bold = /^\s*\\textbf\s*\{/.exec(line);
    if (bold) {
      const g = braceArg(line, bold[0].length - 1);
      if (g) {
        const label = parseInline(g.arg).map((r) => ({ ...r, text: r.text }));
        const labelText = inlineText(label).replace(/:\s*$/, '');
        if (label.length) label[label.length - 1].text = label[label.length - 1].text.replace(/:\s*$/, '');
        if (labelText) {
          rows.push({ label: label.length ? label : parseInline(labelText), items: parseInline(line.slice(g.next)) });
          continue;
        }
      }
    }
    const items = parseInline(line);
    if (items.length) rows.push({ label: [], items });
  }
  return rows;
}

function blocksFrom(src: string, arities: Map<string, number>): Block[] {
  const blocks: Block[] = [];
  const ns = nodes(src, arities);
  let current: Extract<Block, { type: 'entry' | 'project' }> | null = null;
  let loose: Inline[] = [];
  const closeLoose = () => {
    if (loose.length) blocks.push({ type: 'bullets', items: loose });
    loose = [];
  };
  for (const n of ns) {
    if (n.t === 'cmd' && ENTRY_MACROS.has(n.name)) {
      closeLoose();
      current = { type: 'entry', title: parseInline(n.args[0] ?? ''), aside: parseInline(n.args[1] ?? ''), subtitle: parseInline(n.args[2] ?? ''), subAside: parseInline(n.args[3] ?? ''), bullets: [] };
      blocks.push(current);
    } else if (n.t === 'cmd' && PROJECT_MACROS.has(n.name)) {
      closeLoose();
      current = { type: 'project', title: parseInline(n.args[0] ?? ''), tech: parseInline(n.args[1] ?? ''), bullets: [] };
      blocks.push(current);
    } else if (n.t === 'cmd' && BULLET_MACROS.has(n.name)) {
      const b = parseInline(n.args[0] ?? '');
      if (b.length) (current ? current.bullets : loose).push(b);
    } else if (n.t === 'item') {
      const body = n.body.trim().replace(/^\{([\s\S]*)\}$/, '$1');
      if (/\\textbf\s*\{[^}]*:\s*\}/.test(body) && /\\\\/.test(body)) {
        closeLoose();
        current = null;
        blocks.push({ type: 'skills', rows: skillRows(body) });
      } else {
        const b = parseInline(body);
        if (b.length) (current ? current.bullets : loose).push(b);
      }
    } else if (n.t === 'env' && /^(itemize|enumerate)$/.test(n.name)) {
      const inner = blocksFrom(n.body, arities);
      for (const b of inner) {
        if (b.type === 'bullets' && current) current.bullets.push(...b.items);
        else {
          if (b.type !== 'bullets' || !current) closeLoose();
          if (b.type === 'entry' || b.type === 'project') current = b;
          else if (b.type === 'skills' || b.type === 'paragraph') current = null;
          blocks.push(b);
        }
      }
    } else if (n.t === 'text') {
      const content = parseInline(n.text);
      if (content.length) {
        closeLoose();
        current = null;
        blocks.push({ type: 'paragraph', content });
      }
    }
  }
  closeLoose();
  // Adjacent loose bullet lists collapse into one.
  return blocks.reduce<Block[]>((acc, b) => {
    const prev = acc[acc.length - 1];
    if (b.type === 'bullets' && prev?.type === 'bullets') prev.items.push(...b.items);
    else acc.push(b);
    return acc;
  }, []);
}

/**
 * Read a (tailored) LaTeX resume into a ResumeDocument. Throws ResumeDocumentError — never guesses — when
 * the file has no recognisable content, so a bad upload fails loudly instead of producing a thin resume.
 */
export function parseLatexResume(source: string, fallbackName = ''): ResumeDocument {
  const masked = maskComments(source);
  const begin = masked.indexOf('\\begin{document}');
  const endDoc = masked.lastIndexOf('\\end{document}');
  if (begin < 0 || endDoc < 0) throw new ResumeDocumentError('The LaTeX file has no \\begin{document} … \\end{document}.');
  const arities = macroArities(masked.slice(0, begin));
  const body = masked.slice(begin + '\\begin{document}'.length, endDoc);

  const sectionRe = /\\section\*?\s*\{/g;
  const marks: Array<{ title: string; titleEnd: number; start: number }> = [];
  for (let m = sectionRe.exec(body); m; m = sectionRe.exec(body)) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(body, open);
    if (close < 0) continue;
    marks.push({ title: inlineText(parseInline(body.slice(open + 1, close))), titleEnd: close + 1, start: m.index });
  }
  if (!marks.length) throw new ResumeDocumentError('No \\section{…} found, so there is no resume content to draw.');

  // Header: everything before the first section (name, headline, contact line).
  const headerSrc = body.slice(0, marks[0].start).replace(/\\begin\{center\}|\\end\{center\}/g, '');
  const headerLines = headerSrc
    .split(/\\\\(?![a-zA-Z])/)
    .map((l) => l.replace(/\\vspace\*?\{[^}]*\}/g, '').trim())
    .filter((l) => l);
  const lines = headerLines.map((l) => parseInline(l)).filter((l) => l.length);
  const nameLine = lines.shift();
  const name = (nameLine ? inlineText(nameLine) : fallbackName).trim() || fallbackName;
  if (!name) throw new ResumeDocumentError('Could not find your name at the top of the resume.');

  const sections: ResumeSection[] = marks.map((mk, idx) => ({
    title: mk.title,
    blocks: blocksFrom(body.slice(mk.titleEnd, marks[idx + 1]?.start ?? body.length), arities),
  }));
  const empty = sections.filter((s) => !s.blocks.length).map((s) => s.title);
  if (empty.length === sections.length) throw new ResumeDocumentError('The resume sections are empty or use LaTeX commands this reader does not understand.');
  return { name, header: lines, sections: sections.filter((s) => s.blocks.length) };
}

/** Structured master (no LaTeX) → the same document model, so both kinds of master look identical. */
export function documentFromData(r: ResumeData): ResumeDocument {
  const txt = (t: string): Inline => (t ? [{ text: t }] : []);
  const contact: Inline = [];
  const parts: Array<[string, string | undefined]> = [
    [r.basics.phone, undefined],
    [r.basics.email, r.basics.email ? `mailto:${r.basics.email}` : undefined],
    [r.basics.linkedin ? 'LinkedIn' : '', r.basics.linkedin || undefined],
    [r.basics.github ? 'GitHub' : '', r.basics.github || undefined],
    [r.basics.website ? 'Website' : '', r.basics.website || undefined],
  ];
  for (const [label, href] of parts.filter(([l]) => l)) {
    if (contact.length) contact.push({ text: ' | ' });
    contact.push(href ? { text: label, href } : { text: label });
  }
  const header: Inline[] = [[r.basics.headline, r.basics.location].filter(Boolean).join(' | ')].filter(Boolean).map(txt);
  if (contact.length) header.push(contact);

  const sections: ResumeSection[] = [];
  if (r.basics.summary) sections.push({ title: 'Summary', blocks: [{ type: 'paragraph', content: txt(r.basics.summary) }] });
  if (r.skills.length) sections.push({ title: 'Technical Skills', blocks: [{ type: 'skills', rows: r.skills.map((s) => ({ label: txt(s.category), items: txt(s.items.join(', ')) })) }] });
  if (r.experience.length) {
    sections.push({
      title: 'Experience',
      blocks: r.experience.map((e) => ({
        type: 'entry' as const,
        title: txt(e.title),
        aside: txt([e.startDate, e.current ? 'Present' : e.endDate].filter(Boolean).join(' – ')),
        subtitle: txt(e.company),
        subAside: txt(e.location),
        bullets: e.bullets.map((b) => txt(b.text)),
      })),
    });
  }
  if (r.projects.length) {
    sections.push({
      title: 'Projects',
      blocks: r.projects.map((p) => ({ type: 'project' as const, title: txt(p.name), tech: txt(p.technologies.join(', ')), bullets: [...(p.description ? [txt(p.description)] : []), ...p.bullets.map((b) => txt(b.text))] })),
    });
  }
  if (r.achievements.length) sections.push({ title: 'Achievements', blocks: [{ type: 'bullets', items: r.achievements.map((a) => txt(a.text)) }] });
  if (r.certifications.length) sections.push({ title: 'Certifications', blocks: [{ type: 'bullets', items: r.certifications.map((c) => txt([c.name, c.issuer, c.year ? String(c.year) : ''].filter(Boolean).join(' — '))) }] });
  if (r.education.length) {
    sections.push({
      title: 'Education',
      blocks: r.education.map((e) => ({ type: 'entry' as const, title: txt(e.institution), aside: txt(e.year ? String(e.year) : ''), subtitle: txt([e.degree, e.field].filter(Boolean).join(', ')), subAside: [], bullets: [] })),
    });
  }
  if (!sections.length) throw new ResumeDocumentError('The resume has no content to draw.');
  return { name: r.basics.name, header, sections };
}

/** Every piece of body text in reading order — what the finished PDF must contain. */
export function expectedTexts(doc: ResumeDocument): string[] {
  const out: string[] = [doc.name, ...doc.sections.map((s) => s.title)];
  for (const s of doc.sections) {
    for (const b of s.blocks) {
      if (b.type === 'paragraph') out.push(inlineText(b.content));
      else if (b.type === 'skills') for (const r of b.rows) out.push(inlineText(r.items), inlineText(r.label));
      else if (b.type === 'bullets') for (const i of b.items) out.push(inlineText(i));
      else {
        out.push(inlineText(b.title));
        for (const i of b.bullets) out.push(inlineText(i));
      }
    }
  }
  return out.filter((t) => t.trim());
}
