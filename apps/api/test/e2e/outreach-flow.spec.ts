import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../../src/common/prisma.service';
import { EmailAccountsService } from '../../src/modules/email/email-accounts.service';
import { FollowupRunnerService } from '../../src/modules/followups/followup-runner.service';
import { OutreachService, RetryLaterError } from '../../src/modules/outreach/outreach.service';
import { QUEUES, QueueService } from '../../src/modules/queues/queues';
import { checkVoice, countWords } from '../../src/domain/email/voice';
import { BACKEND_JD, createHttpApp, flushRedis, resetDatabase } from '../setup/helpers';

/**
 * End-to-end: Job → Match → Resume → Email → Send → Follow-up → Reply → Follow-up cancellation.
 * HTTP through the real Nest app; worker steps are invoked the way the BullMQ processors call them.
 */
describe('Outreach workflow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let outreach: OutreachService;
  let agent: ReturnType<typeof request.agent>;
  let csrf: string;

  const post = (path: string, body: object = {}) => agent.post(`/api${path}`).set('x-csrf-token', csrf).send(body);
  const patch = (path: string, body: object) => agent.patch(`/api${path}`).set('x-csrf-token', csrf).send(body);
  const get = (path: string) => agent.get(`/api${path}`);

  async function sandboxThread(threadId: string) {
    const acc = await prisma.emailAccount.findFirstOrThrow({ where: { provider: 'SANDBOX' } });
    const svc = app.get(EmailAccountsService);
    return svc.sandbox.getThread(svc.mailbox(acc), threadId);
  }

  async function addJob(companyName: string, email: string) {
    const jd = BACKEND_JD.replace('sarah.lee@acmepay.io', email);
    const res = await post('/jobs/manual', { title: 'Senior Backend Engineer', companyName, description: jd, location: 'Remote', mode: 'paste' }).expect(201);
    const job = (await get(`/jobs/${res.body.jobId}`).expect(200)).body;
    return { jobId: res.body.jobId as string, appId: job.application.id as string, ingest: res.body };
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
    // Allow back-to-back sends inside the test.
    await patch('/settings', { outreach: { minMinutesBetweenSends: 0, maxJitterSeconds: 0 } }).expect(200);
  });

  afterAll(async () => {
    await app.close();
  });

  it('runs the complete flow and cancels follow-ups when the recruiter replies', async () => {
    // ── Job + match ────────────────────────────────────────────────────────
    const { jobId, appId, ingest } = await addJob('AcmePay', 'sarah.lee@acmepay.io');
    expect(ingest.score).toBeGreaterThanOrEqual(80);
    expect(ingest.recommendation).toBe('STRONG_APPLY');
    const job = (await get(`/jobs/${jobId}`)).body;
    expect(job.scoreBreakdown.strong).toEqual(expect.arrayContaining(['Node.js', 'TypeScript', 'Redis']));
    expect(job.scoreBreakdown.missing).not.toContain('Node.js');
    expect(job.scoreBreakdown.components).toHaveLength(8);
    expect(job.scoreBreakdown.breakdown).toMatchObject({ score: job.score, recommendation: 'APPLY' });

    // Duplicate import is detected.
    const dup = await post('/jobs/manual', { title: 'Senior Backend Engineer', companyName: 'AcmePay', description: BACKEND_JD, mode: 'paste' }).expect(201);
    expect(dup.body).toMatchObject({ duplicate: true, jobId });

    // ── Resume ─────────────────────────────────────────────────────────────
    const resume = (await post(`/jobs/${jobId}/resume`).expect(200)).body;
    expect(resume.version.changes.gaps).toEqual(expect.arrayContaining(['Kafka']));
    const pdf = await get(`/resume/versions/${resume.version.id}/pdf`).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');

    // ── Contact ────────────────────────────────────────────────────────────
    const contacts = (await post(`/jobs/${jobId}/contacts/discover`).expect(200)).body;
    expect(contacts.selectedContactId).toBeTruthy();
    expect(contacts.contacts[0]).toMatchObject({ name: 'Sarah Lee', confidence: 'VERIFIED' });

    // ── Email draft ────────────────────────────────────────────────────────
    const draft = (await post(`/applications/${appId}/email`, { style: 'concise' }).expect(201)).body;
    expect(draft.status).toBe('DRAFT');
    expect(draft.body).toMatch(/^Hi Sarah,/);
    expect(draft.body).toContain('AcmePay');
    expect(countWords(draft.body)).toBeLessThanOrEqual(160);
    const profileSkills = ['Node.js', 'TypeScript', 'NestJS', 'Redis', 'BullMQ', 'AWS', 'PostgreSQL', 'MySQL', 'Shopify', 'REST APIs', 'Queue Systems', 'Caching', 'SQL', 'Third-party Integrations', 'EC2', 'RDS', 'CloudWatch', 'GraphQL', 'Docker', 'Distributed Systems', 'Production Debugging', 'Observability', 'Payment Integrations', 'OTP Systems', 'Authentication', 'Database Design', 'Database Migrations', 'JavaScript'];
    expect(checkVoice(draft, { minWords: 40, maxWords: 170, candidateSkills: profileSkills, jobSkills: [...job.extracted.requiredSkills, ...job.extracted.preferredSkills] }).problems).toEqual([]);

    // Nothing is sent without approval.
    expect((await outreach.sendNow(draft.id)).status).toBe('skipped');

    // ── Approve → queued → send (worker) ──────────────────────────────────
    const approved = (await post(`/outreach/${draft.id}/approve`).expect(200)).body;
    expect(approved.outreach.status).toBe('APPROVED');
    const queued = await app.get(QueueService).all()[QUEUES.emailSend].getJob(`send-${draft.id}`);
    expect(queued).toBeDefined();
    await app.get(QueueService).cancelSend(draft.id); // run the worker step inline instead

    expect((await outreach.sendNow(draft.id)).status).toBe('sent');
    // Worker retry after success must not send a second email.
    expect((await outreach.sendNow(draft.id)).status).toBe('already_sent');
    const root = await prisma.outreach.findUniqueOrThrow({ where: { id: draft.id } });
    expect(root.threadState).toBe('WAITING_FOR_REPLY');
    expect(await sandboxThread(root.gmailThreadId!)).toHaveLength(1);

    const appAfterSend = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    expect(appAfterSend.status).toBe('FOLLOWUP_SCHEDULED');
    const plan = await prisma.followup.findMany({ where: { rootId: root.id }, orderBy: { sequence: 'asc' } });
    expect(plan.map((f) => f.status)).toEqual(['SCHEDULED', 'SCHEDULED', 'SCHEDULED']);
    expect(plan[0].scheduledAt.getTime() - root.sentAt!.getTime()).toBeGreaterThanOrEqual(4 * 86_400_000);

    // ── Follow-up #1 becomes due → draft prepared → approved → sent in thread ─
    await prisma.followup.update({ where: { id: plan[0].id }, data: { scheduledAt: new Date(Date.now() - 60_000) } });
    const tick = await app.get(FollowupRunnerService).tick();
    expect(tick.draftsPrepared).toBe(1);
    const f1 = await prisma.followup.findUniqueOrThrow({ where: { id: plan[0].id }, include: { outreach: true } });
    expect(f1.status).toBe('DRAFT_READY');
    expect(f1.outreach!.body).not.toEqual(root.body);
    expect(f1.outreach!.subject).toBe(`Re: ${root.subject}`);

    // Manual mode: the worker does not send unapproved follow-ups.
    expect((await outreach.sendNow(f1.outreachId!)).status).toBe('skipped');
    await post(`/outreach/${f1.outreachId}/approve`).expect(200);
    await app.get(QueueService).cancelSend(f1.outreachId!);
    expect((await outreach.sendNow(f1.outreachId!)).status).toBe('sent');
    const sentF1 = await prisma.outreach.findUniqueOrThrow({ where: { id: f1.outreachId! } });
    expect(sentF1.gmailThreadId).toBe(root.gmailThreadId);
    expect(await sandboxThread(root.gmailThreadId!)).toHaveLength(2);
    expect((await prisma.followup.findUniqueOrThrow({ where: { id: plan[0].id } })).status).toBe('SENT');

    // ── Recruiter replies → everything pending is cancelled ───────────────
    const sim = (await post('/email/sandbox/simulate', { outreachId: root.id, kind: 'reply', body: "Thanks Prince — let's set up a call next week." }).expect(200)).body;
    expect(sim.replied).toBe(true);
    const finalPlan = await prisma.followup.findMany({ where: { rootId: root.id }, orderBy: { sequence: 'asc' } });
    expect(finalPlan.map((f) => f.status)).toEqual(['SENT', 'CANCELLED', 'CANCELLED']);
    expect(finalPlan[1].cancelReason).toBe('Recipient replied');
    const finalApp = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    expect(finalApp.status).toBe('REPLIED');
    expect(finalApp.replySentiment).toBe('positive');

    // Later ticks never resurrect cancelled follow-ups.
    await prisma.followup.updateMany({ where: { rootId: root.id }, data: { scheduledAt: new Date(Date.now() - 1000) } });
    const after = await app.get(FollowupRunnerService).tick();
    expect(after.draftsPrepared).toBe(0);
    expect(await sandboxThread(root.gmailThreadId!)).toHaveLength(3); // 2 sent by us + 1 reply

    // ── Dashboard + analytics ─────────────────────────────────────────────
    const dash = (await get('/dashboard').expect(200)).body;
    expect(dash.stats).toMatchObject({ emailsSent: 1, replies: 1, replyRate: 100 });
    expect(dash.pipeline.find((p: { label: string }) => p.label === 'Replied').count).toBe(1);
    const analytics = (await get('/analytics?fresh=1').expect(200)).body;
    expect(analytics.breakdowns.contactType[0]).toMatchObject({ key: 'engineering manager', sent: 1, replied: 1 });
  });

  it('IF the recruiter replies after a follow-up was approved THEN the follow-up is cancelled, not sent', async () => {
    const { jobId, appId } = await addJob('Globex', 'hm@globex.io');
    await post(`/jobs/${jobId}/contacts/discover`).expect(200);
    const draft = (await post(`/applications/${appId}/email`).expect(201)).body;
    await post(`/outreach/${draft.id}/approve`).expect(200);
    await outreach.sendNow(draft.id);
    const root = await prisma.outreach.findUniqueOrThrow({ where: { id: draft.id } });
    const [f1] = await prisma.followup.findMany({ where: { rootId: root.id }, orderBy: { sequence: 'asc' } });
    await prisma.followup.update({ where: { id: f1.id }, data: { scheduledAt: new Date(Date.now() - 60_000) } });
    const fuDraft = (await post(`/followups/${f1.id}/prepare`).expect(200)).body;
    await post(`/outreach/${fuDraft.id}/approve`).expect(200);

    // Reply lands in the mailbox but has NOT been synced yet.
    const accounts = app.get(EmailAccountsService);
    const acc = await prisma.emailAccount.findFirstOrThrow({ where: { provider: 'SANDBOX' } });
    await accounts.sandbox.simulateInbound(accounts.mailbox(acc), { threadId: root.gmailThreadId!, from: 'HM <hm@globex.io>', subject: 'Re: role', body: 'Got it, will get back to you.' });

    // The send worker re-checks the live mailbox and refuses to send.
    const result = await outreach.sendNow(fuDraft.id);
    expect(result).toEqual({ status: 'cancelled', reason: 'Recipient replied' });
    const statuses = (await prisma.followup.findMany({ where: { rootId: root.id } })).map((f) => f.status);
    expect(statuses.every((s) => s === 'CANCELLED')).toBe(true);
    expect((await prisma.outreach.findUniqueOrThrow({ where: { id: fuDraft.id } })).status).toBe('CANCELLED');
    const thread = await sandboxThread(root.gmailThreadId!);
    expect(thread.filter((m) => m.from.includes('sandbox@'))).toHaveLength(1); // only the initial email
  });

  it('auto-replies (out of office) do not cancel follow-ups; bounces do and suppress the address', async () => {
    const { jobId, appId } = await addJob('Initech', 'lead@initech.io');
    await post(`/jobs/${jobId}/contacts/discover`).expect(200);
    const draft = (await post(`/applications/${appId}/email`).expect(201)).body;
    await post(`/outreach/${draft.id}/approve`).expect(200);
    await outreach.sendNow(draft.id);

    await post('/email/sandbox/simulate', { outreachId: draft.id, kind: 'auto_reply' }).expect(200);
    let fus = await prisma.followup.findMany({ where: { rootId: draft.id } });
    expect(fus.every((f) => f.status === 'SCHEDULED')).toBe(true);

    await post('/email/sandbox/simulate', { outreachId: draft.id, kind: 'bounce' }).expect(200);
    fus = await prisma.followup.findMany({ where: { rootId: draft.id } });
    expect(fus.every((f) => f.status === 'CANCELLED')).toBe(true);
    expect((await prisma.outreach.findUniqueOrThrow({ where: { id: draft.id } })).threadState).toBe('BOUNCED');
    expect(await prisma.suppression.findFirst({ where: { value: 'lead@initech.io' } })).not.toBeNull();
  });

  it('enforces anti-spam guardrails: duplicate recipient, company cooldown, daily limit, suppression', async () => {
    await patch('/settings', { outreach: { dailyInitialLimit: 1, dailyLimit: 5 } }).expect(200);

    const a = await addJob('Umbrella', 'eng@umbrella.io');
    await post(`/jobs/${a.jobId}/contacts/discover`).expect(200);
    const d1 = (await post(`/applications/${a.appId}/email`).expect(201)).body;
    await post(`/outreach/${d1.id}/approve`).expect(200);
    expect((await outreach.sendNow(d1.id)).status).toBe('sent');

    // Same company, different role → company cooldown blocks approval unless overridden.
    const jd2 = BACKEND_JD.replace('Senior Backend Engineer', 'Platform Engineer').replace('sarah.lee@acmepay.io', 'eng@umbrella.io') + '\nPlatform team.';
    const b = (await post('/jobs/manual', { title: 'Platform Engineer', companyName: 'Umbrella', description: jd2, mode: 'paste' }).expect(201)).body;
    const appB = (await get(`/jobs/${b.jobId}`)).body.application.id;
    await post(`/jobs/${b.jobId}/contacts/discover`).expect(200);
    const d2 = (await post(`/applications/${appB}/email`).expect(201)).body;
    const blocked = await post(`/outreach/${d2.id}/approve`).expect(422);
    expect(JSON.stringify(blocked.body)).toMatch(/emailed this person|company/);

    // A different company: allowed to approve, but the daily new-outreach limit defers the send.
    const c = await addJob('Hooli', 'cto@hooli.io');
    await post(`/jobs/${c.jobId}/contacts/discover`).expect(200);
    const d3 = (await post(`/applications/${c.appId}/email`).expect(201)).body;
    await post(`/outreach/${d3.id}/approve`).expect(200);
    await expect(outreach.sendNow(d3.id)).rejects.toBeInstanceOf(RetryLaterError);
    expect((await prisma.outreach.findUniqueOrThrow({ where: { id: d3.id } })).status).toBe('APPROVED');

    // Suppressed domain → the approved-but-unsent email is cancelled immediately and never sent.
    const sup = (await post('/suppressions', { value: 'hooli.io', reason: 'test' }).expect(201)).body;
    expect(sup).toMatchObject({ domain: 'hooli.io', email: null, emailsCancelled: 1 });
    expect((await prisma.outreach.findUniqueOrThrow({ where: { id: d3.id } })).status).toBe('CANCELLED');
    expect(await outreach.sendNow(d3.id)).toMatchObject({ status: 'skipped' });
    await post(`/outreach/${d3.id}/approve`).expect(409);
    // A fresh draft to the suppressed domain can't be approved either.
    const d4 = (await post(`/applications/${c.appId}/email`, { regenerate: true }).expect(201)).body;
    await post(`/outreach/${d4.id}/approve`).expect(422);
  });

  it('protects the API: auth required, CSRF enforced, input validated', async () => {
    const anon = request(app.getHttpServer());
    await anon.get('/api/jobs').expect(401);
    await agent.post('/api/jobs/manual').send({ title: 'x' }).expect(403); // missing CSRF header
    const bad = await post('/jobs/manual', { title: 'x', companyName: '', description: 'short' }).expect(400);
    expect(bad.body.issues.length).toBeGreaterThan(0);
    await post('/auth/register', { email: 'second@example.com', password: 'another-long-password', name: 'X' }).expect(403); // registration closed
    await post('/jobs/import-url', { url: 'http://127.0.0.1:4000/api/health' }).expect(400); // SSRF guard
    await get('/jobs/not-a-uuid').expect(400);
  });
});
