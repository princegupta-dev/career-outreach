import type { INestApplication } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import { PrismaService } from '../../src/common/prisma.service';
import { BACKEND_JD, createHttpApp, flushRedis, pdfBrowserAvailable, resetDatabase } from '../setup/helpers';

/**
 * candidate/resume.tex (next to the profile) is picked up as the LaTeX template without an upload,
 * and tailored versions keep its design: same preamble and macros, only re-ordered content.
 */
describe('Candidate LaTeX resume from candidate/resume.tex (e2e)', () => {
  const SOURCE = fs.readFileSync(path.resolve(__dirname, '../../../../candidate/resume.example.tex'), 'utf8');
  const target = path.join(path.dirname(process.env.CANDIDATE_PROFILE_PATH!), 'resume.tex');
  let app: INestApplication;
  let prisma: PrismaService;
  let agent: ReturnType<typeof request.agent>;
  let csrf: string;
  let hasBrowser = false;

  const post = (p: string, body: object = {}) => agent.post(`/api${p}`).set('x-csrf-token', csrf).send(body);
  const get = (p: string) => agent.get(`/api${p}`);

  beforeAll(async () => {
    fs.copyFileSync(path.resolve(__dirname, '../../../../candidate/resume.example.tex'), target);
    app = await createHttpApp();
    prisma = app.get(PrismaService);
    hasBrowser = await pdfBrowserAvailable();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await flushRedis();
    agent = request.agent(app.getHttpServer());
    csrf = (await get('/auth/csrf').expect(200)).body.csrfToken;
    await post('/auth/register', { email: 'prince@example.com', password: 'correct-horse-battery', name: 'Prince Gupta' }).expect(201);
  });

  afterAll(async () => {
    fs.rmSync(target, { force: true });
    await app.close();
  });

  it('uses the file as the master template and tailors it without changing the design', async () => {
    const master = (await get('/resume/master').expect(200)).body;
    expect(master.latex).toMatchObject({ engine: 'chromium' });
    expect(master.latex.sections).toEqual(expect.arrayContaining(['Experience', 'Production Challenges', 'Selected Projects']));
    expect((await get('/resume/master/tex').expect(200)).text).toBe(SOURCE);

    const job = (await post('/jobs/manual', { title: 'Senior Backend Engineer', companyName: 'AcmePay', description: BACKEND_JD, location: 'Remote', mode: 'paste' }).expect(201)).body;
    const { version } = (await post(`/jobs/${job.jobId}/resume`).expect(200)).body;
    expect(version.changes.format).toBe('latex');
    const tex = (await get(`/resume/versions/${version.id}/tex`).expect(200)).text;
    const preamble = (s: string) => s.slice(0, s.indexOf('\\begin{document}'));
    expect(preamble(tex)).toBe(preamble(SOURCE));
    expect(tex.length).toBe(SOURCE.length);
    expect(tex).toContain('AWS (EC2, RDS, S3, Lambda)');

    if (hasBrowser) {
      expect(version.compileStatus).toBe('ok');
      const pdf = await get(`/resume/versions/${version.id}/pdf`).expect(200);
      expect(pdf.headers['content-type']).toMatch(/pdf/);
    } else {
      // No browser here: a clear, actionable message — never a LaTeX error, never a different resume.
      expect(version.compileStatus).toBe('failed');
      expect(version.compileLog).toMatch(/playwright install chromium/);
      expect(version.compileLog).not.toMatch(/pdflatex|TeX/i);
    }
  });

  it('does not re-import after the user removed the LaTeX template', async () => {
    await get('/resume/master').expect(200);
    await agent.delete('/api/resume/latex').set('x-csrf-token', csrf).expect(204);
    const master = (await get('/resume/master').expect(200)).body;
    expect(master.latex).toBeNull();
  });
});
