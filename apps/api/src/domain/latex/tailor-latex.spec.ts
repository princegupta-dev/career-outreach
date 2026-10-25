import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLatex } from './latex';
import { latexSummary, tailorLatex } from './tailor-latex';

const source = readFileSync(join(__dirname, '../../../../../candidate/resume.example.tex'), 'utf8');
const weights = new Map<string, number>([['Node.js', 3]]);

describe('latexSummary', () => {
  it('finds the plain summary paragraph under \\section{Summary}', () => {
    const sum = latexSummary(parseLatex(source));
    expect(sum?.text).toMatch(/^Software Engineer with/);
    expect(source.slice(sum!.start, sum!.end).startsWith('Software Engineer')).toBe(true);
  });
});

describe('tailorLatex: summary', () => {
  const original = latexSummary(parseLatex(source))!.text;

  it('replaces the summary with a safe rewrite', () => {
    const text = original.replace('Strong in investigating', 'Skilled at investigating');
    const r = tailorLatex(source, weights, { summaryRewrite: text, summarySkills: ['Node.js', 'TypeScript', 'NestJS', 'Redis', 'Shopify'] });
    expect(r.rejected).toEqual([]);
    expect(r.latex).toContain('Skilled at investigating');
    expect(r.changes.some((c) => c.section === 'summary')).toBe(true);
  });

  it('rejects a summary that adds a technology, a number, or a lot of length', () => {
    const r = tailorLatex(source, weights, { summaryRewrite: `${original} Also expert in Elasticsearch and Django, 10 years.`, summarySkills: [] });
    expect(r.rejected[0]?.id).toBe('summary');
    expect(r.latex).toBe(source);
  });
});

describe('tailorLatex: confirmed skills', () => {
  it('adds a confirmed skill to the matching skills line, keeping the layout', () => {
    const r = tailorLatex(source, weights, { addSkills: ['Elasticsearch', 'Django'] });
    expect(r.latex).toMatch(/Databases \\& Caching:\} [^\\]*Elasticsearch/);
    expect(r.latex).toMatch(/Backend:\} [^\\]*Django/);
    expect(r.changes.filter((c) => /Added skill you confirmed/.test(c.change))).toHaveLength(2);
    // only the skills lines changed
    const before = source.split('\n');
    const after = r.latex.split('\n');
    expect(after).toHaveLength(before.length);
    const changed = after.filter((l, i) => l !== before[i]);
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every((l) => /\\textbf\{/.test(l))).toBe(true);
  });

  it('does not add a skill the resume already has', () => {
    const r = tailorLatex(source, weights, { addSkills: ['Redis'] });
    expect(r.changes.some((c) => /Added skill/.test(c.change))).toBe(false);
  });

  it('adds nothing by default', () => {
    expect(tailorLatex(source, new Map(), {}).latex).toBe(source);
  });
});
