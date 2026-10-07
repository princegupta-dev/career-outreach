import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../../src/common/prisma.service';
import { SEND_MODE_CONFIRMATION } from '../../src/domain/settings';
import { JobsService } from '../../src/modules/jobs/jobs.service';
import { OutreachService } from '../../src/modules/outreach/outreach.service';
import { BACKEND_JD, createHttpApp, flushRedis, resetDatabase } from '../setup/helpers';

/**
 * Job-search automation policies over HTTP:
 * send modes (DRY_RUN / DRAFT_ONLY / APPROVAL_REQUIRED / AUTO_SEND), explicit AUTO_SEND opt-in,
 * email verification gate, current-employer block, dedupe and the dashboard pipeline API.
 */
describe('Automation policies (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let outreach: OutreachService;
  let agent: ReturnType<typeof request.agent>;
  let csrf: string;

  const post = (path: string, body: object = {}) => agent.post(`/api${path}`).set('x-csrf-token', csrf).send(body);
  const put = (path: string, body: object) => agent.put(`/api${path}`).set('x-csrf-token', csrf).send(body);
  const patch = (path: string, body: object) => agent.patch(`/api${path}`).set('x-csrf-token', csrf).send(body);
  const get = (path: string) => agent.get(`/api${path}`);

  async function addJob(companyName: string, email: string, title = 'Senior Backend Engineer') {
    const jd = BACKEND_JD.replace('sarah.lee@acmepay.io', email);
    const res = await post('/jobs/manual', { title, companyName, description: jd, location: 'Remote', mode: 'paste' }).expect(201);
    const job = (await get(`/jobs/${res.body.jobId}`).expect(200)).body;
    return { jobId: res.body.jobId as string, appId: job.application.id as string, companyId: job.company.id as string };
  }

  async function draftFor(companyName: string, email: string) {
    const j = await addJob(companyName, email);
    await post(`/jobs/${j.jobId}/contacts/discover`).expect(200);
    const draft = (await post(`/applications/${j.appId}/email`).expect(201)).body;
    return { ...j, draftId: draft.id as string };
  }

  beforeAll(async () => {
    app = await createHttpApp();
    prisma = app.get(PrismaService);
    outreach = app.get(OutreachService);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await flushRedis();
    agent = request.agent(app.getHttpServer());
    csrf = (await get('/auth/csrf').expect(200)).body.csrfToken;
    await post('/auth/register', { email: 'prince@example.com', password: 'correct-horse-battery', name: 'Prince Gupta' }).expect(201);
    await patch('/settings', { outreach: { minMinutesBetweenSends: 0, maxJitterSeconds: 0 } }).expect(200);
  });

  afterAll(async () => {
    await app.close();
  });

  it('defaults to APPROVAL_REQUIRED and never enables AUTO_SEND without the explicit confirmation', async () => {
    const policy = (await get('/pipeline/send-policy').expect(200)).body;
    expect(policy).toMatchObject({ sendMode: 'APPROVAL_REQUIRED', hourlyLimit: 4, perDomainDailyLimit: 2, autoSendConfirmation: SEND_MODE_CONFIRMATION });

    const refused = await put('/pipeline/send-policy', { sendMode: 'AUTO_SEND' }).expect(400);
    expect(refused.body.details?.requiredConfirmation ?? refused.body.message).toBeTruthy();
    await patch('/settings', { outreach: { sendMode: 'AUTO_SEND' } }).expect(400);
    expect((await get('/pipeline/send-policy').expect(200)).body.sendMode).toBe('APPROVAL_REQUIRED');

    await put('/pipeline/send-policy', { sendMode: 'AUTO_SEND', confirmation: SEND_MODE_CONFIRMATION }).expect(200);
    expect((await get('/pipeline/send-policy').expect(200)).body.sendMode).toBe('AUTO_SEND');
    // Already on: other edits don't need the confirmation again.
    await put('/pipeline/send-policy', { hourlyLimit: 3 }).expect(200);
    expect(await prisma.auditLog.count({ where: { action: 'settings.send_mode_changed' } })).toBe(1);
  });

  it('DRY_RUN renders and checks everything but sends nothing', async () => {
    await put('/pipeline/send-policy', { sendMode: 'DRY_RUN' }).expect(200);
    const { draftId } = await draftFor('AcmePay', 'sarah.lee@acmepay.io');
    await post(`/outreach/${draftId}/approve`).expect(200);
    expect(await outreach.sendNow(draftId)).toEqual({ status: 'dry_run' });
    const o = await prisma.outreach.findUniqueOrThrow({ where: { id: draftId } });
    expect(o).toMatchObject({ status: 'DRAFT', sentAt: null, gmailMessageId: null });
    expect(await prisma.emailEvent.count({ where: { outreachId: draftId, type: 'DRY_RUN' } })).toBe(1);
    expect(await prisma.emailEvent.count({ where: { outreachId: draftId, type: 'SENT' } })).toBe(0);
    expect(await prisma.followup.count({ where: { rootId: draftId } })).toBe(0);
  });

  it('DRAFT_ONLY prepares drafts but refuses to send', async () => {
    await put('/pipeline/send-policy', { sendMode: 'DRAFT_ONLY' }).expect(200);
    const { draftId } = await draftFor('AcmePay', 'sarah.lee@acmepay.io');
    const res = await post(`/outreach/${draftId}/approve`).expect(422);
    expect(JSON.stringify(res.body)).toMatch(/DRAFT_ONLY/);
  });

  it('only emails publicly listed / verified addresses; manual addresses need a source', async () => {
    const j = await addJob('Globex', 'careers@globex.io');
    // A manually typed address with no public source stays UNKNOWN and cannot be sent to.
    const manual = (await post(`/companies/${j.companyId}/contacts`, { name: 'Hank Scorpio', role: 'Engineering Manager', email: 'hank@globex.io' }).expect(201)).body;
    expect(manual.verificationStatus).toBe('UNKNOWN');
    await post(`/applications/${j.appId}/contact`, { contactId: manual.id }).expect(200);
    const draft = (await post(`/applications/${j.appId}/email`, { contactId: manual.id }).expect(201)).body;
    const blocked = await post(`/outreach/${draft.id}/approve`).expect(422);
    expect(JSON.stringify(blocked.body)).toMatch(/only publicly listed or verified/);

    // Marking it publicly listed requires the page it is published on.
    await agent.patch(`/api/contacts/${manual.id}`).set('x-csrf-token', csrf).send({ verificationStatus: 'PUBLICLY_LISTED' }).expect(400);
    await agent
      .patch(`/api/contacts/${manual.id}`)
      .set('x-csrf-token', csrf)
      .send({ verificationStatus: 'PUBLICLY_LISTED', sourceUrl: 'https://globex.io/team' })
      .expect(200);
    await post(`/outreach/${draft.id}/approve`).expect(200);

    // Discovery: the posting address is PUBLICLY_LISTED with its source.
    const discovered = (await post(`/jobs/${j.jobId}/contacts/discover`).expect(200)).body;
    expect(discovered.status).toBe('FOUND');
    expect(discovered.contacts.find((c: { email: string }) => c.email === 'careers@globex.io')).toMatchObject({ verificationStatus: 'PUBLICLY_LISTED', sourceType: 'JOB_POSTING', sendable: true });
  });

  it('reports EMAIL_NOT_FOUND instead of guessing', async () => {
    const jd = BACKEND_JD.replace(/\S+@\S+/g, '');
    const res = await post('/jobs/manual', { title: 'Senior Backend Engineer', companyName: 'NoMail Inc', description: jd, location: 'Remote', mode: 'paste' }).expect(201);
    const r = (await post(`/jobs/${res.body.jobId}/contacts/discover`).expect(200)).body;
    expect(r).toMatchObject({ status: 'EMAIL_NOT_FOUND', selectedContactId: null });
    const view = (await get(`/pipeline/applications/${(await get(`/jobs/${res.body.jobId}`)).body.application.id}`).expect(200)).body;
    expect(view.email_status).toBe('EMAIL_NOT_FOUND');
  });

  it('never prepares or sends to the current employer', async () => {
    const res = await post('/jobs/manual', { title: 'Senior Backend Engineer', companyName: 'Almonds.ai', description: BACKEND_JD, location: 'Gurgaon', mode: 'paste' }).expect(201);
    expect(res.body.recommendation).toBe('SKIP');
  });

  it('deduplicates by company + role + location and by URL across sources', async () => {
    const jobs = app.get(JobsService);
    const user = await prisma.user.findFirstOrThrow();
    const base = { companyName: 'Acme Technologies Pvt Ltd', title: 'Sr. Backend Engineer', location: 'Bengaluru, India', description: BACKEND_JD };
    const a = await jobs.ingest(user.id, { ...base, provider: 'CAREER_PAGE', url: 'https://acme.com/careers/backend' });
    const b = await jobs.ingest(user.id, { ...base, provider: 'HIMALAYAS', companyName: 'Acme', title: 'Senior Backend Engineer', location: 'Bangalore', description: `${BACKEND_JD}\nApply today.` });
    expect(b).toMatchObject({ duplicate: true, jobId: a.jobId });
    const c = await jobs.ingest(user.id, { ...base, provider: 'REMOTIVE', title: 'Backend Platform Engineer', description: `${BACKEND_JD}\nDifferent text.`, url: 'https://acme.com/careers/backend?utm_source=x' });
    expect(c).toMatchObject({ duplicate: true, jobId: a.jobId });
    const stored = await prisma.job.findUniqueOrThrow({ where: { id: a.jobId } });
    expect(stored).toMatchObject({ canonicalUrl: 'https://acme.com/careers/backend', applicationUrl: 'https://acme.com/careers/backend', experienceRequired: '3+ years' });
    expect(stored.dedupeKey).toHaveLength(64);
  });

  it('serves the dashboard pipeline: summary, filtered list, applied / skip, sent-email log', async () => {
    const { appId, draftId } = await draftFor('AcmePay', 'sarah.lee@acmepay.io');
    const other = await addJob('Initech', 'jobs@initech.io');

    let list = (await get('/pipeline/applications').expect(200)).body;
    expect(list.total).toBe(2);
    const item = list.items.find((i: { id: string }) => i.id === appId);
    expect(item).toMatchObject({
      company: 'AcmePay',
      role: 'Senior Backend Engineer',
      status: 'APPLICATION_READY',
      email_status: 'DRAFT',
      contact: { email: 'sarah.lee@acmepay.io', verification_status: 'PUBLICLY_LISTED', source_type: 'JOB_POSTING' },
      scoring: { recommendation: 'APPLY', strong_matches: expect.arrayContaining(['Node.js']) },
    });
    expect(item.match_score).toBeGreaterThanOrEqual(70);

    await post(`/pipeline/applications/${other.appId}/applied`, { note: 'Applied on the careers site' }).expect(200);
    await post(`/pipeline/applications/${other.appId}/skip`, {}).expect(409); // invalid transition: already applied
    expect((await get(`/pipeline/applications/${other.appId}`).expect(200)).body).toMatchObject({ status: 'APPLIED', application_date: expect.any(String) });

    await post(`/outreach/${draftId}/approve`).expect(200);
    await outreach.sendNow(draftId);
    list = (await get('/pipeline/applications?status=EMAIL_SENT').expect(200)).body;
    expect(list.items.map((i: { id: string }) => i.id)).toEqual([appId]);
    expect(list.items[0]).toMatchObject({ reply_status: 'NO_REPLY', next_followup_date: expect.any(String), last_contact_date: expect.any(String) });

    const summary = (await get('/pipeline/summary').expect(200)).body;
    expect(summary.byStatus).toMatchObject({ EMAIL_SENT: 1, APPLIED: 1 });
    expect(summary.outreach).toMatchObject({ sendMode: 'APPROVAL_REQUIRED', sentToday: 1, remainingThisHour: 3 });

    const emails = (await get('/pipeline/emails').expect(200)).body;
    expect(emails.items[0]).toMatchObject({ recipient: 'sarah.lee@acmepay.io', company: 'AcmePay', reply_detected: false, message_id: expect.any(String), thread_id: expect.any(String) });

    await post('/email/sandbox/simulate', { outreachId: draftId, kind: 'reply' }).expect(200);
    expect((await get(`/pipeline/applications/${appId}`).expect(200)).body).toMatchObject({ status: 'REPLIED', reply_status: 'REPLIED', followups_pending: 0 });
  });

  it('AUTO_SEND approves strong matches with a publicly listed address — and nothing else', async () => {
    await put('/pipeline/send-policy', { sendMode: 'AUTO_SEND', confirmation: SEND_MODE_CONFIRMATION, autoSendMinScore: 70 }).expect(200);
    const strong = await draftFor('AcmePay', 'sarah.lee@acmepay.io');
    expect(await outreach.autoApproveIfAllowed((await prisma.user.findFirstOrThrow()).id, strong.draftId)).toBe(true);
    expect((await prisma.outreach.findUniqueOrThrow({ where: { id: strong.draftId } })).status).toBe('APPROVED');
    expect(await prisma.auditLog.count({ where: { action: 'outreach.auto_approved' } })).toBe(1);

    // Same flow with an UNKNOWN manual address: stays a draft for review.
    const j = await addJob('Globex', 'careers@globex.io');
    const manual = (await post(`/companies/${j.companyId}/contacts`, { name: 'Hank Scorpio', role: 'Engineering Manager', email: 'hank@globex.io' }).expect(201)).body;
    const d = (await post(`/applications/${j.appId}/email`, { contactId: manual.id }).expect(201)).body;
    expect(await outreach.autoApproveIfAllowed((await prisma.user.findFirstOrThrow()).id, d.id)).toBe(false);
    expect((await prisma.outreach.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('DRAFT');
  });
});
