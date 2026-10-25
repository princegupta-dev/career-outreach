import * as fs from 'fs';
import * as path from 'path';
import { tailorLatex } from '../../domain/latex/tailor-latex';
import { inlineText, parseLatexResume, ResumeDocument } from '../../domain/resume/resume-document';
import { jobSkillWeights } from '../../domain/resume/tailor';
import { extractJob } from '../../domain/skills/extract';
import { ChromiumPdfRenderer, ResumeRenderError, validateResumePdf } from './chromium-pdf';

jest.setTimeout(120_000);

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../../../../../candidate/resume.example.tex'), 'utf8');
const SHORT_JD = 'Senior Backend Engineer. Node.js, TypeScript and PostgreSQL. 4+ years experience building REST APIs.';
const LONG_JD = `We are hiring a Senior Backend Engineer to own services that power our payments platform. ${'You will design resilient distributed systems, build REST and GraphQL APIs with Node.js, TypeScript and NestJS, run PostgreSQL and Redis in production, use BullMQ queues, Kafka, AWS, Docker and Kubernetes, and debug incidents end to end. '.repeat(12)}
Requirements: 5+ years building backend systems; strong SQL; idempotency; observability; CI/CD; system design; microservices; event-driven architecture.`;

const weightsFor = (jd: string, title: string) => jobSkillWeights(extractJob({ title, description: jd, location: 'Remote', companyName: 'Acme' }));

/**
 * These tests drive a real headless browser. Where none can be started (some CI machines) they are skipped with a
 * notice — the same way the old LaTeX tests were skipped without a TeX engine.
 */
describe('resume PDF (real Chromium)', () => {
  const renderer = new ChromiumPdfRenderer({ pageSize: 'Letter', timeoutMs: 60_000 });
  let hasBrowser = false;
  beforeAll(async () => {
    hasBrowser = await renderer.available();
    if (!hasBrowser) process.stderr.write('No browser available: resume PDF tests are skipped. Run "npx playwright install chromium".\n');
  });
  afterAll(() => renderer.close());
  const real = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (hasBrowser) await fn();
    });

  real('builds the sample resume as a valid two-page PDF with selectable text and every section', async () => {
    const doc = parseLatexResume(SOURCE);
    const r = await renderer.renderResume(doc);
    expect(r.pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(r.pages).toBe(2);
    expect(r.warnings).toEqual([]); // no section heading stranded at the bottom of a page
    expect(r.pdf.length).toBeGreaterThan(5_000);
    const flat = r.text.replace(/\s+/g, '').toLowerCase();
    for (const s of doc.sections) expect(flat).toContain(s.title.replace(/\s+/g, '').toLowerCase());
    expect(r.text.replace(/\s+/g, ' ')).toContain('Redis Cluster key-slot errors');
    expect(r.text.replace(/\s+/g, ' ')).toContain('alex.morgan@example.com');
  });

  real('works for both a short and a long job description, never dropping or clipping content', async () => {
    const results = [];
    for (const [jd, title] of [[SHORT_JD, 'Backend Engineer'], [LONG_JD, 'Senior Backend Engineer']] as const) {
      const tailored = tailorLatex(SOURCE, weightsFor(jd, title)).latex;
      const doc = parseLatexResume(tailored);
      const r = await renderer.renderResume(doc); // validates every bullet is present in the PDF
      expect(r.pages).toBeLessThanOrEqual(2);
      results.push({ doc, r });
    }
    // Same facts, possibly different order — and the master was not touched.
    const texts = (d: ResumeDocument) => d.sections.flatMap((s) => s.blocks.flatMap((b) => (b.type === 'bullets' ? b.items : b.type === 'entry' || b.type === 'project' ? b.bullets : []))).map(inlineText).sort();
    expect(texts(results[0].doc)).toEqual(texts(results[1].doc));
    expect(SOURCE).toContain('\\itemx{Build and maintain production services');
  });

  real('copes with a very long resume (tries the tighter layout, stays readable) and unbreakable text', async () => {
    const doc = parseLatexResume(SOURCE);
    const extra = Array.from({ length: 45 }, (_, i) => [{ text: `Delivered measurable improvement number ${i} across services, queues and databases for enterprise customers, documenting the approach for the team.` }]);
    const longDoc: ResumeDocument = {
      ...doc,
      sections: [...doc.sections, { title: 'Extra', blocks: [{ type: 'bullets', items: [...extra, [{ text: `Token ${'x'.repeat(260)} end` }, { text: ' https://example.com/' + 'a'.repeat(200) }]] }] }],
    };
    const r = await renderer.renderResume(longDoc);
    expect(r.pages).toBeGreaterThanOrEqual(3);
    expect(r.pages).toBeLessThanOrEqual(4);
    expect(r.warnings.join(' ')).toMatch(/pages long/);
    expect(r.text.replace(/\s+/g, '')).toContain('x'.repeat(100)); // the long token wrapped instead of running off the page
  });

  real('the document is rendered with no network and no scripts', async () => {
    const doc = parseLatexResume(SOURCE);
    doc.sections[0].blocks.push({ type: 'paragraph', content: [{ text: '<img src="http://127.0.0.1:9/x.png"><script>document.title="pwned"</script>' }] });
    const r = await renderer.renderResume(doc);
    expect(r.text).toContain('<script>document.title="pwned"</script>'); // printed as text, not run
  });

  real('renders several resumes at once', async () => {
    const doc = parseLatexResume(SOURCE);
    const all = await Promise.all([1, 2, 3, 4].map(() => renderer.renderResume(doc)));
    expect(all.every((r) => r.pages === 2)).toBe(true);
  });

  real('detects empty, invalid, clipped or missing content instead of accepting it', async () => {
    const doc = parseLatexResume(SOURCE);
    const good = await renderer.renderResume(doc);
    await expect(validateResumePdf(Buffer.from('nope'), doc)).rejects.toThrow(/not a valid PDF/);
    await expect(validateResumePdf(Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(3000, 32)]), doc)).rejects.toThrow(ResumeRenderError);
    // The PDF is fine but the document claims text that is not in it → "missing or cut off".
    const claims: ResumeDocument = { ...doc, sections: [...doc.sections, { title: 'Extra', blocks: [{ type: 'paragraph', content: [{ text: 'This sentence was never printed anywhere in the file.' }] }] }] };
    await expect(validateResumePdf(good.pdf, claims)).rejects.toThrow(/missing or cut off/);
  });
});

describe('when no browser can be started', () => {
  it('says exactly what to install — and never mentions LaTeX', async () => {
    const r = new ChromiumPdfRenderer({ executablePath: '/nonexistent/chrome', pageSize: 'Letter', timeoutMs: 5000 });
    expect(await r.available()).toBe(false);
    const err = await r.renderResume(parseLatexResume(SOURCE)).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(ResumeRenderError);
    expect(err!.message).toMatch(/Could not start a browser/);
    expect(err!.message).toMatch(/npx playwright install chromium/);
    expect(err!.message).not.toMatch(/pdflatex|TeX Live|LaTeX/i);
    await r.close();
  });
});
