import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../../src/common/prisma.service';
import { PreparationService } from '../../src/modules/preparation/preparation.service';
import { createHttpApp, flushRedis, resetDatabase } from '../setup/helpers';
import { installMockWeb } from '../setup/mock-web';

const JD =
  'We are hiring a Senior Backend Engineer to build payment APIs with Node.js, TypeScript, PostgreSQL, Redis and AWS. ' +
  '4+ years of experience building backend systems with message queues and REST APIs. Remote, open to candidates in India.';

/** The routes the redesigned job page uses, end to end over HTTP. */
describe('Job page + application preparation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let agent: ReturnType<typeof request.agent>;
  let csrf: string;
  let web: ReturnType<typeof installMockWeb>;

  const post = (p: string, body: object = {}) => agent.post(`/api${p}`).set('x-csrf-token', csrf).send(body);
  const get = (p: string) => agent.get(`/api${p}`);

  beforeAll(async () => {
    app = await createHttpApp();
    prisma = app.get(PrismaService);
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    await prisma.preparationWorkflow.deleteMany();
    await flushRedis();
    web = installMockWeb();
    agent = request.agent(app.getHttpServer());
    csrf = (await get('/auth/csrf')).body.csrfToken;
    await post('/auth/register', { email: 'prince@example.com', password: 'correct-horse-battery', name: 'Prince Gupta' }).expect(201);
  });
  afterEach(() => web.restore());
  afterAll(async () => app.close());

  const addJob = async () => {
    const r = await post('/jobs/manual', { title: 'Senior Backend Engineer', companyName: 'AcmeCorp', description: JD, location: 'Remote (Worldwide)', url: 'https://acmecorp.com/careers/backend', companyWebsite: 'https://acmecorp.com' }).expect(201);
    return r.body.jobId as string;
  };

  it('the job page data answers "should I apply?" and "what next?" in one response', async () => {
    const id = await addJob();
    const job = (await get(`/jobs/${id}`).expect(200)).body;
    expect(job.summary).toMatchObject({ verdictLabel: expect.stringMatching(/match|manually|recommended/i), facts: { salary: { known: false }, companySize: { known: false, label: 'Unknown' } } });
    expect(typeof job.summary.explanation).toBe('string');
    expect(job.lifecycle).toMatchObject({ stage: 'DISCOVERED', stageLabel: 'Discovered', needsAction: true });
    expect(job.summary.toVerify.length).toBeGreaterThan(0);
  });

  it('prepare → progress → review → approve, then it shows as Approved (not Applied) until the email is actually sent', async () => {
    const id = await addJob();
    expect((await get(`/jobs/${id}/preparation`).expect(200)).body).toMatchObject({ status: 'NOT_STARTED', workflowId: null });

    const a = (await post(`/jobs/${id}/preparation/start`).expect(200)).body;
    const b = (await post(`/jobs/${id}/preparation/start`).expect(200)).body; // double click
    expect(a).toMatchObject({ status: 'IN_PROGRESS', statusLabel: 'In progress' });
    expect(b.workflowId).toBe(a.workflowId);
    expect((await get(`/jobs/${id}`)).body.lifecycle).toMatchObject({ stage: 'PREPARING', label: 'Preparing…', needsAction: false });

    await app.get(PreparationService).execute(a.workflowId); // what the worker does

    const ready = (await get(`/jobs/${id}/preparation`).expect(200)).body;
    expect(ready).toMatchObject({ status: 'READY_FOR_REVIEW', mode: 'EMAIL' });
    expect(ready.steps.map((s: { statusLabel: string }) => s.statusLabel)).toEqual(Array(5).fill('Completed'));
    expect(ready.review.email).toMatchObject({ to: 'careers@acmecorp.com', status: 'DRAFT' });
    expect((await get(`/jobs/${id}`)).body.lifecycle).toMatchObject({ stage: 'READY_FOR_REVIEW', label: 'Review and approve', needsAction: true });

    // The resume link the page shows really serves a PDF.
    const pdf = await get(ready.review.resume.previewUrl.replace('/api', '')).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    const done = (await post(`/jobs/${id}/preparation/approve`).expect(200)).body;
    expect(done).toMatchObject({ status: 'COMPLETED' });
    const after = (await get(`/jobs/${id}`)).body;
    expect(after.lifecycle).toMatchObject({ stage: 'APPROVED', stageLabel: 'Approved' });
    expect(after.application.outreach[0].status).toBe('APPROVED');
    expect(after.application.status).not.toBe('APPLIED');
  });

  it('shortlist, skip, restore and "I applied" go through one validated endpoint', async () => {
    const id = await addJob();
    const appId = (await get(`/jobs/${id}`)).body.application.id;
    const act = (action: string) => post(`/applications/${appId}/lifecycle`, { action });
    expect((await act('shortlist').expect(200)).body.lifecycle).toMatchObject({ stage: 'SHORTLISTED', label: 'Prepare application' });
    expect((await act('skip').expect(200)).body.lifecycle).toMatchObject({ stage: 'SKIPPED', needsAction: false });
    const bad = await act('mark_applied').expect(409);
    expect(bad.body.message).toMatch(/while the job is "skipped"/);
    expect((await act('restore').expect(200)).body.lifecycle.stage).toBe('SHORTLISTED');
    expect((await act('mark_applied').expect(200)).body.lifecycle).toMatchObject({ stage: 'APPLIED', label: 'Wait for reply' });
    await post(`/applications/${appId}/lifecycle`, { action: 'explode' }).expect(400);
  });

  it('the jobs list has next-action ordering and the new filters', async () => {
    const id = await addJob();
    const appId = (await get(`/jobs/${id}`)).body.application.id;
    await post(`/applications/${appId}/lifecycle`, { action: 'shortlist' }).expect(200);
    const list = (await get('/jobs?sort=priority&needsAction=true&stage=SHORTLISTED&source=PASTE&location=remote&companySize=UNKNOWN').expect(200)).body;
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ lifecycle: { label: 'Prepare application', kind: 'prepare' }, verdict: { label: expect.any(String) } });
    expect((await get('/jobs?stage=APPLIED').expect(200)).body.total).toBe(0);
    await get('/jobs?stage=NOPE').expect(400);
  });

  it('rejects bad input and unauthenticated or forged requests', async () => {
    const id = await addJob();
    await post(`/jobs/${id}/preparation/steps/NOPE/retry`).expect(400);
    await post(`/jobs/${id}/preparation/steps/RESUME/skip`).expect(409); // only a failed resume step can be skipped
    await post(`/jobs/${id}/preparation/steps/COMPANY/skip`).expect(400);
    await post(`/jobs/${id}/preparation/steps/RESUME/retry`).expect(409); // nothing to retry yet
    await post(`/jobs/${id}/preparation/approve`).expect(409); // nothing prepared
    await agent.post(`/api/jobs/${id}/preparation/start`).send({}).expect(403); // no CSRF token
    await request(app.getHttpServer()).get(`/api/jobs/${id}/preparation`).expect(401);
    await post('/jobs/00000000-0000-4000-8000-000000000000/preparation/start').expect(404);
  });
});
