import * as fs from 'fs';
import * as path from 'path';
import { BACKEND_JD } from '../__fixtures__/fixtures';
import { jobSkillWeights } from '../resume/tailor';
import { extractJob } from '../skills/extract';
import { latexEscape, latexOutline, latexToText, maskComments, parseLatex, validateLatexUpload } from './latex';
import { lineDiff, tailorLatex } from './tailor-latex';

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../__fixtures__/resume.tex'), 'utf8');
const weights = jobSkillWeights(extractJob({ title: 'Senior Backend Engineer', description: BACKEND_JD }));

/** Everything except bullet order / skills order must be byte-identical. */
function normalize(src: string): string {
  return src.split('\n').sort().join('\n');
}

describe('LaTeX parsing', () => {
  const doc = parseLatex(SOURCE);

  it('finds sections in the document body only (not preamble macros)', () => {
    expect(doc.sections.map((s) => s.title)).toEqual(['Experience', 'Projects', 'Technical Skills']);
  });

  it('finds leaf bullet lists and their items', () => {
    const exp = doc.lists.filter((l) => l.section === 'Experience');
    expect(exp).toHaveLength(1);
    expect(exp[0].items.map((i) => i.text)).toEqual([
      'Built internal admin dashboards in React for the support team',
      'Maintained CI pipelines and release scripts',
      'Designed REST APIs in Node.js and TypeScript for the billing service',
      'Added Redis caching and BullMQ background jobs to the order pipeline',
    ]);
    expect(exp[0].items[2].simple).toBe(false); // contains \textbf
    expect(exp[0].items[0].simple).toBe(true);
  });

  it('ignores braces inside comments', () => {
    expect(maskComments('a % } b\nc')).toBe('a      \nc');
    expect(parseLatex(SOURCE).lists.find((l) => l.section === 'Experience')!.items[3].text).not.toContain('noisy');
  });

  it('finds comma-separated skills lines', () => {
    expect(doc.skillSegments.map((s) => s.items)).toEqual([
      ['Python', 'Go', 'TypeScript', 'JavaScript', 'SQL'],
      ['React', 'Flask', 'NestJS'],
      ['Git', 'Docker', 'Redis', 'AWS'],
    ]);
  });

  it('converts LaTeX to plain text and escapes safely', () => {
    expect(latexToText('Cut costs by 50\\% with \\textbf{Redis} \\href{https://x.y}{here}')).toBe('Cut costs by 50% with Redis here');
    expect(latexEscape('C# & 50% of_users {x}')).toBe('C\\# \\& 50\\% of\\_users \\{x\\}');
  });

  it('rejects unsafe or invalid uploads', () => {
    expect(validateLatexUpload(SOURCE)).toEqual([]);
    expect(validateLatexUpload('hello')).toHaveLength(2);
    expect(validateLatexUpload(`${SOURCE}\n\\immediate\\write18{rm -rf /}`).join()).toMatch(/Shell-escape/);
  });

  it('produces a readable outline', () => {
    const outline = latexOutline(doc);
    expect(outline).toContain('Experience');
    expect(outline).toContain('• Designed REST APIs in Node.js and TypeScript for the billing service');
  });
});

describe('LaTeX tailoring (design-preserving)', () => {
  const result = tailorLatex(SOURCE, weights);

  it('moves the most JD-relevant bullets first', () => {
    const exp = parseLatex(result.latex).lists.find((l) => l.section === 'Experience')!;
    expect(exp.items[0].text).toMatch(/Node\.js|Redis/);
    expect(exp.items[exp.items.length - 1].text).toMatch(/React|CI pipelines/);
  });

  it('re-orders skills without adding or removing any', () => {
    const segs = parseLatex(result.latex).skillSegments;
    expect(segs[0].items[0]).toBe('TypeScript');
    expect([...segs[0].items].sort()).toEqual(['Go', 'JavaScript', 'Python', 'SQL', 'TypeScript']);
    expect(segs[2].items.slice(0, 2)).toEqual(['Redis', 'AWS']);
  });

  it('changes nothing but order: same lines, same preamble, same length', () => {
    expect(result.latex).not.toEqual(SOURCE);
    expect(result.latex.length).toBe(SOURCE.length);
    const pre = (s: string) => s.slice(0, s.indexOf('\\begin{document}'));
    expect(pre(result.latex)).toBe(pre(SOURCE));
    // Every master line still exists (bullet lines move; skills lines are permuted in place).
    const masterBullets = SOURCE.split('\n').filter((l) => l.includes('\\resumeItem{'));
    for (const l of masterBullets) expect(result.latex).toContain(l.trim());
    expect(normalize(result.latex.replace(/\\textbf\{\w+\}\{:[^}]*\}/g, ''))).toBe(normalize(SOURCE.replace(/\\textbf\{\w+\}\{:[^}]*\}/g, '')));
  });

  it('is deterministic and idempotent', () => {
    expect(tailorLatex(SOURCE, weights).latex).toBe(result.latex);
    expect(tailorLatex(result.latex, weights).latex).toBe(result.latex);
  });

  it('applies guarded rephrasings and rejects invented facts', () => {
    const bullets = result.bullets;
    const redis = bullets.find((b) => /Redis caching/.test(b.text))!;
    const react = bullets.find((b) => /React/.test(b.text))!;
    const restApi = bullets.find((b) => /REST APIs/.test(b.text))!;
    const r = tailorLatex(SOURCE, weights, {
      rewrites: [
        { id: redis.id, text: 'Added Redis caching & BullMQ background jobs to the order pipeline', reason: 'wording' },
        { id: react.id, text: 'Built admin dashboards in React and Kafka, cutting load time by 40%' },
        { id: restApi.id, text: 'Designed REST APIs' },
      ],
    });
    expect(r.latex).toContain('\\resumeItem{Added Redis caching \\& BullMQ background jobs to the order pipeline}');
    expect(r.rejected.find((x) => x.id === react.id)!.reasons.join()).toMatch(/Kafka|40/);
    expect(r.rejected.find((x) => x.id === restApi.id)!.reasons.join()).toMatch(/formatting/);
    expect(r.latex).not.toContain('Kafka');
  });

  it('leaves a resume without matching content untouched', () => {
    const noMatch = tailorLatex(SOURCE, new Map());
    expect(noMatch.latex).toBe(SOURCE);
    expect(noMatch.changes).toEqual([]);
  });

  it('diffs master vs tailored by line', () => {
    const d = lineDiff('a\nb\nc', 'a\nc\nb');
    expect(d.filter((x) => x.type !== 'same')).toHaveLength(2);
    expect(lineDiff(SOURCE, SOURCE).every((x) => x.type === 'same')).toBe(true);
  });
});

describe("Prince's own resume (candidate/resume.tex)", () => {
  const PRINCE = fs.readFileSync(path.resolve(__dirname, '../../../../../candidate/resume.tex'), 'utf8');
  const backend = jobSkillWeights(
    extractJob({ title: 'Senior Backend Engineer', description: 'Requirements: Node.js, PostgreSQL, Kafka, AWS, Docker, Kubernetes, Redis, TypeScript, idempotency, distributed systems.' }),
  );
  const result = tailorLatex(PRINCE, backend);
  // Same lines in any order, with comma-separated parts in any order (skills are permuted in place).
  const lowerLines = (s: string) =>
    s
      .toLowerCase()
      .split('\n')
      .map((l) => l.split(/, |\} |\\\\/).sort().join(', '))
      .sort()
      .join('\n');

  it('keeps parenthesised groups and trailing ";" clauses intact in skills lines', () => {
    const segs = parseLatex(PRINCE).skillSegments.map((s) => s.items);
    expect(segs).toContainEqual(['AWS (EC2, RDS, S3, Lambda)', 'Docker', 'Kubernetes', 'Jenkins', 'CI/CD']);
    expect(segs).toContainEqual(['LLM integration', 'AI-assisted workflows', 'content summarization', 'intelligent automation']);
    expect(result.latex).toContain('AWS (EC2, RDS, S3, Lambda)');
    expect(result.latex).toContain('intelligent automation; exploring RAG and AI agents\\\\');
  });

  it('tailors Experience, Production Challenges and project bullets (\\itemx) in place', () => {
    const sections = result.changes.map((c) => c.change).join('\n');
    expect(sections).toMatch(/Experience/);
    expect(sections).toMatch(/Production Challenges/);
    const exp = parseLatex(result.latex).lists.find((l) => l.section === 'Experience')!;
    expect(exp.items).toHaveLength(9);
    expect(exp.items.every((i) => i.macro === 'itemx' && i.simple)).toBe(true);
  });

  it('changes only order: preamble, macros and every line are preserved', () => {
    const pre = (s: string) => s.slice(0, s.indexOf('\\begin{document}'));
    expect(pre(result.latex)).toBe(pre(PRINCE));
    expect(result.latex.length).toBe(PRINCE.length);
    expect(lowerLines(result.latex)).toBe(lowerLines(PRINCE));
  });

  it('keeps sentence case when a lower-case skill moves to the front', () => {
    expect(result.latex).toContain('\\textbf{Engineering:} Distributed systems, system design,');
  });

  it('rephrases a plain \\itemx bullet inside the macro and rejects invented tech', () => {
    const b = result.bullets.find((x) => /Improve database access/.test(x.text))!;
    const r = tailorLatex(PRINCE, backend, {
      rewrites: [
        { id: b.id, text: 'Improved API responsiveness and database access through SQL tuning, indexing, Redis caching, and efficient data-access patterns.' },
        { id: result.bullets.find((x) => /Shopify APIs/.test(x.text))!.id, text: 'Integrated Shopify and Kafka event streams for 10M users.' },
      ],
    });
    expect(r.latex).toContain('\\itemx{Improved API responsiveness and database access through SQL tuning, indexing, Redis caching, and efficient data-access patterns.}');
    expect(r.rejected).toHaveLength(1);
    expect(r.latex).not.toContain('Kafka');
  });
});
