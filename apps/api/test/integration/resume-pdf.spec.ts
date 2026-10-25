import * as fs from 'fs';
import * as path from 'path';
import type { INestApplicationContext } from '@nestjs/common';
import { PrismaService } from '../../src/common/prisma.service';
import { JobsService } from '../../src/modules/jobs/jobs.service';
import { ResumeService } from '../../src/modules/resume/resume.service';
import { ResumeRenderError } from '../../src/providers/documents/chromium-pdf';
import { BACKEND_JD, createContext, createUser, flushRedis, pdfBrowserAvailable, resetDatabase } from '../setup/helpers';

jest.setTimeout(120_000);

const TEX = fs.readFileSync(path.resolve(__dirname, '../../../../candidate/resume.tex'));
const SHORT_JD = 'Backend Engineer needed. Node.js, TypeScript, PostgreSQL. 3+ years building REST APIs for our product.';
const pdfText = async (b: Buffer | Uint8Array) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const parse = require('pdf-parse/lib/pdf-parse.js') as (b: Buffer) => Promise<{ numpages: number; text: string }>;
  return parse(Buffer.from(b));
};

/** "Tailor resume" end to end, with the real browser where there is one. */
describe('Resume tailoring → PDF (integration)', () => {
  let ctx: INestApplicationContext;
  let prisma: PrismaService;
  let resumes: ResumeService;
  let jobs: JobsService;
  let userId: string;
  let hasBrowser = false;
  let n = 0;

  beforeAll(async () => {
    ctx = await createContext();
    prisma = ctx.get(PrismaService);
    resumes = ctx.get(ResumeService);
    jobs = ctx.get(JobsService);
    hasBrowser = await pdfBrowserAvailable();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    await flushRedis();
    userId = (await createUser(prisma)).id;
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => ctx.close());

  const upload = () => resumes.uploadLatex(userId, [{ originalname: 'resume.tex', buffer: TEX, mimetype: 'application/x-tex' }]);
  const job = async (description: string, title = 'Senior Backend Engineer') => (await jobs.createManual(userId, { title, companyName: 'AcmePay', description, location: 'Remote', url: `https://acmepay.test/jobs/${++n}` })).jobId;
  const masterRow = () => prisma.resume.findFirstOrThrow({ where: { userId, isMaster: true } });

  const real = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (hasBrowser) await fn();
    });

  real('uploading your .tex builds and stores a validated PDF — no TeX involved', async () => {
    const r = await upload();
    expect(r).toMatchObject({ compiled: true, error: null, engine: 'chromium' });
    expect(r.summary).toMatchObject({ rendererAvailable: true });
    const m = await prisma.resume.findFirstOrThrow({ where: { userId, isMaster: true } });
    expect(Buffer.from(m.pdf!).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await pdfText(m.pdf!)).numpages).toBe(2);
  });

  real('"Tailor resume" produces a PDF for a short and a long job description, and never touches the master', async () => {
    await upload();
    const before = await masterRow();
    const short = await job(SHORT_JD, 'Backend Engineer');
    const long = await job(BACKEND_JD);
    const a = await resumes.tailor(userId, short);
    const b = await resumes.tailor(userId, long);
    for (const { version } of [a, b]) {
      expect(version).toMatchObject({ compileStatus: 'ok', compileLog: null });
      expect((version.changes as unknown as { pages: number }).pages).toBeLessThanOrEqual(2);
      const file = await resumes.renderPdf(userId, version.id);
      const parsed = await pdfText(file.buffer);
      expect(parsed.numpages).toBeLessThanOrEqual(2);
      expect(parsed.text.replace(/\s+/g, ' ')).toContain('Redis Cluster key-slot errors'); // every section survives tailoring
      expect(parsed.text.replace(/\s+/g, ' ')).toContain('Indira Gandhi University');
      expect(file.filename).toMatch(/_Resume\.pdf$/);
    }
    expect(a.version.id).not.toBe(b.version.id);
    // The master resume is exactly what it was.
    const after = await masterRow();
    expect(after.latexSource).toBe(before.latexSource);
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.latexHash).toBe(before.latexHash);
  });

  real('repeating the request reuses the saved resume, and even a forced re-tailor leaves the master alone', async () => {
    await upload();
    const before = await masterRow();
    const id = await job(BACKEND_JD);
    const first = await resumes.tailor(userId, id);
    expect(first.reused).toBe(false);
    const again = await resumes.tailor(userId, id);
    expect(again).toMatchObject({ reused: true });
    expect(again.version.id).toBe(first.version.id);
    const forced = await resumes.tailor(userId, id, { force: true });
    expect(forced.reused).toBe(false);
    expect(await prisma.resumeVersion.count({ where: { jobId: id } })).toBe(1); // same inputs → same row, not a pile of copies
    const after = await masterRow();
    expect(after.latexSource).toBe(before.latexSource);
    expect(after.contentHash).toBe(before.contentHash);
  });

  real('without a LaTeX master, the structured resume gets the same validated PDF', async () => {
    const id = await job(BACKEND_JD);
    const { version } = await resumes.tailor(userId, id);
    expect(version).toMatchObject({ compileStatus: 'ok' });
    const parsed = await pdfText((await resumes.renderPdf(userId, version.id)).buffer);
    expect(parsed.text.length).toBeGreaterThan(300);
    expect((await resumes.masterSummary(userId)).latex).toBeNull();
  });

  real('a failed build shows a clear message (no LaTeX wording), is not reused, and retrying fixes it', async () => {
    await upload();
    const id = await job(BACKEND_JD);
    const broken = jest.spyOn(resumes.pdf, 'renderResume').mockRejectedValue(new ResumeRenderError('Could not start a browser to build the PDF. Install it with "npx playwright install chromium".'));
    const failed = await resumes.tailor(userId, id);
    expect(failed.version.compileStatus).toBe('failed');
    expect(failed.version.compileLog).toMatch(/playwright install chromium/);
    expect(failed.version.compileLog).not.toMatch(/pdflatex|TeX/i);
    await expect(resumes.renderPdf(userId, failed.version.id)).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/could not be built: Could not start a browser/) });
    expect((await prisma.application.findFirstOrThrow({ where: { jobId: id } })).resumeVersionId).toBeNull(); // a broken resume is never attached to the application
    broken.mockRestore(); // the browser is installed now

    const retried = await resumes.tailor(userId, id); // "Retry"
    expect(retried.reused).toBe(false);
    expect(retried.version).toMatchObject({ id: failed.version.id, compileStatus: 'ok', compileLog: null });
    expect((await prisma.application.findFirstOrThrow({ where: { jobId: id } })).resumeVersionId).toBe(retried.version.id);
  });

  real('heals a resume left broken by the old LaTeX engine: the Resume page and old failed versions rebuild themselves', async () => {
    await upload();
    const id = await job(BACKEND_JD);
    const { version } = await resumes.tailor(userId, id);
    // Simulate what an existing database looks like after the machine had no pdflatex.
    const oldError = 'pdflatex is not installed. Run the app with Docker (TeX Live is included) or install TeX Live / MacTeX locally.';
    await prisma.resume.updateMany({ where: { userId, isMaster: true }, data: { pdf: null, compileLog: oldError, latexEngine: 'pdflatex' } });
    await prisma.resumeVersion.update({ where: { id: version.id }, data: { pdf: null, compileStatus: 'failed', compileLog: oldError } });

    const summary = await resumes.masterSummary(userId);
    expect(summary.latex).toMatchObject({ compiled: true, compileLog: null, engine: 'chromium' });
    const file = await resumes.renderPdf(userId, version.id); // the stale "failed" version is rebuilt on demand
    expect(file.buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(await prisma.resumeVersion.findUniqueOrThrow({ where: { id: version.id } })).toMatchObject({ compileStatus: 'ok', compileLog: null });
  });

  real('a user who never opened the Resume page still gets a master PDF (approving an email attaches it)', async () => {
    expect(await prisma.resume.count({ where: { userId } })).toBe(0); // no master exists yet
    const { buffer, filename } = await resumes.renderPdf(userId, null);
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(filename).toMatch(/_Resume\.pdf$/);
    expect(await prisma.resume.count({ where: { userId, isMaster: true } })).toBe(1);
  });

  it('an unreadable .tex is rejected at upload with a plain explanation', async () => {
    await expect(resumes.uploadLatex(userId, [{ originalname: 'r.tex', buffer: Buffer.from('\\documentclass{article}\\begin{document}\\section{Experience}\\end{document}'), mimetype: 'x' }])).rejects.toMatchObject({ status: 400 });
  });

  it('the Resume page is told when no browser is available, and what to install', async () => {
    jest.spyOn(resumes.pdf, 'available').mockResolvedValueOnce(false);
    expect(await resumes.masterSummary(userId)).toMatchObject({ rendererAvailable: false });
  });
});
