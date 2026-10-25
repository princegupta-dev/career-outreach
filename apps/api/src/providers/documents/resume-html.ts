import type { Block, Inline, ResumeDocument } from '../../domain/resume/resume-document';

export type PageSize = 'Letter' | 'A4';

export interface HtmlOptions {
  pageSize?: PageSize;
  /** Slightly tighter type and spacing — used when the default layout runs past the target page count. */
  compact?: boolean;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Only real web/mail/phone links survive; anything else (javascript:, data:, file:) is dropped. */
export function safeHref(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

function inline(runs: Inline): string {
  return runs
    .map((r) => {
      let h = esc(r.text);
      if (r.code) h = `<code>${h}</code>`;
      if (r.italic) h = `<em>${h}</em>`;
      if (r.bold) h = `<strong>${h}</strong>`;
      const href = safeHref(r.href);
      return href ? `<a href="${esc(href)}">${h}</a>` : h;
    })
    .join('');
}

function bullets(items: Inline[], kind: 'dash' | 'dot'): string {
  return items.length ? `<ul class="${kind}">${items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>` : '';
}

function block(b: Block): string {
  switch (b.type) {
    case 'paragraph':
      return `<p class="para">${inline(b.content)}</p>`;
    case 'skills':
      return `<div class="skills">${b.rows.map((r) => `<p class="skill">${r.label.length ? `<strong>${inline(r.label)}:</strong> ` : ''}${inline(r.items)}</p>`).join('')}</div>`;
    case 'bullets':
      return bullets(b.items, 'dot');
    case 'entry':
      return `<div class="entry"><div class="row head"><span class="title">${inline(b.title)}</span><span class="aside">${inline(b.aside)}</span></div>${
        b.subtitle.length || b.subAside.length ? `<div class="row sub"><span>${inline(b.subtitle)}</span><span class="aside">${inline(b.subAside)}</span></div>` : ''
      }${bullets(b.bullets, 'dash')}</div>`;
    case 'project':
      return `<div class="entry"><div class="row head"><span><span class="title">${inline(b.title)}</span>${b.tech.length ? ` <span class="bar">|</span> <em>${inline(b.tech)}</em>` : ''}</span></div>${bullets(b.bullets, 'dash')}</div>`;
  }
}

/**
 * The resume template: one column, real text (no images or icons), standard fonts, generous but controlled
 * spacing, and print rules so headings stay with their content and bullets are not split across pages.
 * Times New Roman on macOS/Windows and Liberation Serif in Docker are metric-compatible, so the layout
 * (and page count) is the same everywhere.
 */
export function renderResumeHtml(doc: ResumeDocument, opts: HtmlOptions = {}): string {
  const size: PageSize = opts.pageSize ?? 'Letter';
  const base = opts.compact ? 9.5 : 10;
  const css = `
@page { size: ${size}; margin: 0.5in 0.6in 0.55in; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; color: #111; background: #fff; font-family: "Times New Roman", "Liberation Serif", Tinos, "Nimbus Roman", Georgia, serif; font-size: ${base}pt; line-height: ${opts.compact ? 1.24 : 1.3}; font-variant-ligatures: none; overflow-wrap: anywhere; orphans: 2; widows: 2; }
header { text-align: center; margin-bottom: ${opts.compact ? 4 : 6}pt; }
h1 { margin: 0; font-size: ${opts.compact ? 22 : 24}pt; line-height: 1.1; font-weight: 700; letter-spacing: 0.2pt; }
.hline { margin-top: 2pt; font-size: ${base - 0.5}pt; }
section { margin-top: ${opts.compact ? 7 : 9}pt; }
h2 { margin: 0 0 ${opts.compact ? 3 : 4}pt; padding-bottom: 1pt; border-bottom: 0.75pt solid #111; font-size: ${base + 1.5}pt; line-height: 1.2; font-weight: 600; font-variant: small-caps; letter-spacing: 0.6pt; break-after: avoid; }
p { margin: 0; }
.para { text-align: left; }
.skill { margin: 0 0 1.5pt; }
.entry { margin-top: ${opts.compact ? 3 : 4}pt; }
.entry:first-child { margin-top: 0; }
.row { display: flex; justify-content: space-between; align-items: baseline; gap: 14pt; }
.row.head { break-after: avoid; }
.row.sub { font-style: italic; font-size: ${base - 0.5}pt; break-after: avoid; }
.title { font-weight: 700; }
.aside { white-space: nowrap; }
.bar { margin: 0 1pt; }
ul { margin: 2pt 0 0; padding: 0 0 0 13pt; list-style: none; }
li { margin: 0 0 ${opts.compact ? 1 : 1.5}pt; break-inside: avoid; }
/* Inline markers, no positioning: positioned elements are painted (and written to the PDF) after everything else,
   which scrambles the reading order that ATS parsers and copy-paste see. */
li::before { display: inline-block; width: 11pt; margin-left: -11pt; }
ul.dash li::before { content: "–"; }
ul.dot li::before { content: "•"; }
section > ul.dot { margin-top: 1pt; }
a { color: inherit; text-decoration: none; }
code { font-family: "Courier New", "Liberation Mono", Courier, monospace; font-size: ${base - 1}pt; }
`.trim();

  const header = doc.header.map((l, i) => `<div class="hline"${i === 0 ? ' data-role="headline"' : ''}>${inline(l)}</div>`).join('');
  const sections = doc.sections.map((s) => `<section><h2>${esc(s.title)}</h2>${s.blocks.map(block).join('')}</section>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${esc(doc.name)} — Resume</title>
<style>${css}</style>
</head>
<body>
<header><h1>${esc(doc.name)}</h1>${header}</header>
${sections}
</body>
</html>`;
}
