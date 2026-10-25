import type { INestApplication } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import { PrismaService } from '../../src/common/prisma.service';
import { BACKEND_JD, createHttpApp, flushRedis, resetDatabase } from '../setup/helpers';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const JSZip = require('jszip') as new () => { file(name: string, data: string): void; generateAsync(o: { type: 'nodebuffer' }): Promise<Buffer> };

/** A real (minimal) Word document, built in memory. */
async function docx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const RESUME_LINES = [
  'Prince Gupta',
  'Backend Engineer | Gurgaon, India',
  'pg@example.com | +91 90000 00000',
  'Summary',
  'Backend engineer with 3+ years building Node.js and TypeScript services for loyalty platforms.',
  'Experience',
  'Senior Software Engineer, Tech Almond Solutions — May 2023 – Present',
  '• Built NestJS services and REST APIs for enterprise loyalty platforms.',
  '• Built BullMQ background workflows with retries for third-party integrations.',
  '• Tuned PostgreSQL queries and added Redis caching.',
  'Skills',
  'Languages: TypeScript, JavaScript, SQL',
  'Backend: Node.js, NestJS, Express.js',
  'Education',
  'B.Tech Computer Science, Indira Gandhi University, 2023',
];

describe('Resume Studio: versioned master resume (e2e)', () => {
  const target = path.join(path.dirname(process.env.CANDIDATE_PROFILE_PATH!), 'resume.tex');
  let app: INestApplication;
  let prisma: PrismaService;
  let agent: ReturnType<typeof request.agent>;
  let csrf: string;

  const post = (p: string, body: object = {}) => agent.post(`/api${p}`).set('x-csrf-token', csrf).send(body);
  const put = (p: string, body: object) => agent.put(`/api${p}`).set('x-csrf-token', csrf).send(body);
  const del = (p: string) => agent.delete(`/api${p}`).set('x-csrf-token', csrf);
  const get = (p: string) => agent.get(`/api${p}`);
  const upload = (buf: Buffer, name: string) => agent.post('/api/resume/sources').set('x-csrf-token', csrf).attach('file', buf, name);

  beforeAll(async () => {
    fs.copyFileSync(path.resolve(__dirname, '../../../../candidate/resume.tex'), target);
    app = await createHttpApp();
    prisma = app.get(PrismaService);
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

  it('keeps the existing resume as version 1 and makes it active', async () => {
    const list = (await get('/resume/sources').expect(200)).body;
    expect(list.versions).toHaveLength(1);
    expect(list.versions[0]).toMatchObject({ versionNo: 1, kind: 'LEGACY', status: 'CONFIRMED' });
    expect(list.activeId).toBe(list.versions[0].id);
    // calling again does not create another snapshot
    expect((await get('/resume/sources').expect(200)).body.versions).toHaveLength(1);
  });

  it('accepts only real PDF and DOCX files', async () => {
    await upload(Buffer.from('hello world '.repeat(20)), 'resume.txt').expect(400);
    await upload(Buffer.from('not a pdf at all '.repeat(20)), 'resume.pdf').expect(400);
    await upload(Buffer.from('not a zip at all '.repeat(20)), 'resume.docx').expect(400);
    expect((await get('/resume/sources').expect(200)).body.versions).toHaveLength(1);
  });

  it('stores an upload unchanged, extracts it for review, and does not touch the master until activated', async () => {
    const file = await docx(RESUME_LINES);
    const before = (await get('/resume/master/tex').expect(200)).text;
    const v = (await upload(file, 'Prince.docx').expect(201)).body;
    expect(v).toMatchObject({ versionNo: 2, kind: 'UPLOAD', status: 'PENDING_REVIEW', originalName: 'Prince.docx', sizeBytes: file.length });
    expect(v.confidence).toBeGreaterThan(0.5);
    expect(v.warnings.join(' ')).toMatch(/not treated as verified/);
    expect(v.originalFile).toBeUndefined();

    const full = (await get(`/resume/sources/${v.id}`).expect(200)).body;
    expect(full.extractedText).toContain('BullMQ background workflows');
    expect(full.data.experience.length).toBeGreaterThan(0);

    const raw = await get(`/resume/sources/${v.id}/file`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(Buffer.compare(raw.body as Buffer, file)).toBe(0);

    // the same file again is the same version
    expect((await upload(file, 'Prince.docx').expect(201)).body.id).toBe(v.id);
    // master still the LaTeX resume
    expect((await get('/resume/master/tex').expect(200)).text).toBe(before);
    expect((await get('/resume/sources').expect(200)).body.activeId).not.toBe(v.id);
  });

  it('activating a new version leaves tailored resumes built from the old one unchanged', async () => {
    const job = (await post('/jobs/manual', { title: 'Senior Backend Engineer', companyName: 'AcmePay', description: BACKEND_JD, location: 'Remote', mode: 'paste' }).expect(201)).body;
    const v1 = (await get('/resume/sources').expect(200)).body.activeId;
    const t1 = (await post(`/jobs/${job.jobId}/resume`).expect(200)).body.version;
    expect(t1.sourceVersionId).toBe(v1);
    const t1Row = await prisma.resumeVersion.findUniqueOrThrow({ where: { id: t1.id } });

    const v2 = (await upload(await docx(RESUME_LINES), 'Prince.docx').expect(201)).body;
    const draft = (await get(`/resume/sources/${v2.id}`).expect(200)).body;
    draft.data.basics.summary = 'Backend engineer with 3+ years building Node.js services.';
    await put(`/resume/sources/${v2.id}`, { data: draft.data }).expect(200);
    await post(`/resume/sources/${v2.id}/activate`).expect(200);

    const master = (await get('/resume/master').expect(200)).body;
    expect(master.data.basics.summary).toBe('Backend engineer with 3+ years building Node.js services.');
    expect(master.latex).toBeNull(); // drawn from the uploaded content now, not resume.tex
    // resume.tex is not imported over the activated upload again
    expect((await get('/resume/master').expect(200)).body.latex).toBeNull();

    const t1After = await prisma.resumeVersion.findUniqueOrThrow({ where: { id: t1.id } });
    expect(t1After.latex).toBe(t1Row.latex);
    expect(t1After.contentHash).toBe(t1Row.contentHash);
    expect(t1After.sourceVersionId).toBe(v1);

    const t2 = (await post(`/jobs/${job.jobId}/resume`).expect(200)).body.version;
    expect(t2.id).not.toBe(t1.id);
    expect(t2.sourceVersionId).toBe(v2.id);
  });

  it('never edits a confirmed version: an edit becomes a new version, and the old one can be activated again', async () => {
    const v1 = (await get('/resume/sources').expect(200)).body.versions[0];
    const full = (await get(`/resume/sources/${v1.id}`).expect(200)).body;
    const edited = { ...full.data, basics: { ...full.data.basics, headline: 'Backend Engineer' } };
    const v2 = (await put(`/resume/sources/${v1.id}`, { data: edited }).expect(200)).body;
    expect(v2).toMatchObject({ versionNo: 2, kind: 'EDIT', status: 'PENDING_REVIEW', parentId: v1.id });
    expect((await get(`/resume/sources/${v1.id}`).expect(200)).body.data.basics.headline).toBe(full.data.basics.headline);

    await post(`/resume/sources/${v2.id}/activate`).expect(200);
    expect((await get('/resume/master').expect(200)).body.data.basics.headline).toBe('Backend Engineer');
    await post(`/resume/sources/${v1.id}/activate`).expect(200);
    const back = (await get('/resume/master').expect(200)).body;
    expect(back.latex).not.toBeNull(); // the resume.tex layout is back
    expect(back.data.basics.headline).toBe(full.data.basics.headline);
  });

  it('discards only versions still under review', async () => {
    const v1 = (await get('/resume/sources').expect(200)).body.activeId;
    const v2 = (await upload(await docx(RESUME_LINES), 'Prince.docx').expect(201)).body;
    await del(`/resume/sources/${v1}`).expect(409);
    await del(`/resume/sources/${v2.id}`).expect(204);
    expect((await get('/resume/sources').expect(200)).body.versions.map((v: { id: string }) => v.id)).toEqual([v1]);
    await post(`/resume/sources/${v2.id}/activate`).expect(409);
  });

  it('records edits made in the old resume editor as a new active version', async () => {
    const before = (await get('/resume/sources').expect(200)).body;
    const m = (await get('/resume/master').expect(200)).body;
    await put('/resume/master', { data: { ...m.data, basics: { ...m.data.basics, headline: 'Changed in editor' } } }).expect(200);
    const after = (await get('/resume/sources').expect(200)).body;
    expect(after.versions).toHaveLength(before.versions.length + 1);
    expect(after.activeId).toBe(after.versions[0].id);
    expect(after.versions[0]).toMatchObject({ kind: 'EDIT', status: 'CONFIRMED' });
  });
});
