import * as fs from 'fs';
import * as path from 'path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../../src/common/prisma.service';
import { DiscoveryService } from '../../src/modules/discovery/discovery.service';
import { EmailAccountsService } from '../../src/modules/email/email-accounts.service';
import { FollowupRunnerService } from '../../src/modules/followups/followup-runner.service';
import { OutreachService } from '../../src/modules/outreach/outreach.service';
import { QueueService } from '../../src/modules/queues/queues';
import { createHttpApp, flushRedis, pdfBrowserAvailable, resetDatabase } from '../setup/helpers';
import { installMockWeb } from '../setup/mock-web';

const LATEX = fs.readFileSync(path.resolve(__dirname, '../../src/domain/__fixtures__/resume.tex'), 'utf8');

/**
 * Acceptance test: "We found X relevant jobs for you today" →
 * View Job → Match Score → Contact → Tailored Resume → Download PDF → Preview Email →
 * Approve → Send → Track → Follow-up → Reply → follow-ups cancelled.
 */
describe('Autonomous discovery → cold outreach (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let agent: ReturnType<typeof request.agent>;
  let csrf: string;
  let web: ReturnType<typeof installMockWeb>;
  let hasBrowser = false;

  const post = (p: string, body: object = {}) => agent.post(`/api${p}`).set('x-csrf-token', csrf).send(body);
  const get = (p: string) => agent.get(`/api${p}`);

  beforeAll(async () => {
    app = await createHttpApp();
    prisma = app.get(PrismaService);
    hasBrowser = await pdfBrowserAvailable();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    await flushRedis();
    web = installMockWeb();
    agent = request.agent(app.getHttpServer());
    csrf = (await get('/auth/csrf')).body.csrfToken;
    await post('/auth/register', { email: 'prince@example.com', password: 'correct-horse-battery', name: 'Prince Gupta' }).expect(201);
    await agent.patch('/api/settings').set('x-csrf-token', csrf).send({ outreach: { minMinutesBetweenSends: 0 }, automation: { minScoreToPrepare: 60 } }).expect(200);
    await app.get(QueueService).all()['discovery'].obliterate({ force: true }); // run discovery inline instead of via the worker
  });
  afterEach(() => web.restore());
  afterAll(async () => app.close());

  it('needs no pasted job descriptions: the dashboard shows today\'s jobs and every step works to the reply', async () => {
    const user = await prisma.user.findFirstOrThrow();
    // Sign-up seeded the default sources (no configuration needed).
    expect(await prisma.jobSource.count({ where: { userId: user.id, isDefault: true } })).toBeGreaterThan(40);
    await prisma.jobSource.create({ data: { userId: user.id, provider: 'GREENHOUSE', name: 'AcmeCorp', config: { boardToken: 'acmecorp', companyName: 'AcmeCorp', domain: 'acmecorp.com' } } });

    // The scheduled/auto run (what the worker does every morning).
    await app.get(DiscoveryService).runAll(user.id, 'schedule');

    // ── Dashboard: "We found X relevant jobs for you today." ──
    const today = (await get('/discovery/today').expect(200)).body;
    expect(today.relevant).toBeGreaterThanOrEqual(2);
    expect(today.lastRun.stats.sources).toBeGreaterThan(40);
    const top = today.jobs.find((j: { company: { name: string } }) => j.company.name === 'Paylane');
    expect(top).toBeDefined();

    // ── View job + match score ──
    const job = (await get(`/jobs/${top.id}`).expect(200)).body;
    expect(job.score).toBeGreaterThanOrEqual(75);
    expect(job.scoreBreakdown.strong).toEqual(expect.arrayContaining(['Node.js', 'TypeScript', 'Redis']));
    expect(job.resumeVersions[0].pdf).toBeUndefined(); // no binary in JSON

    // ── Contact (from the HN post, verified) ──
    expect(job.application.contact).toMatchObject({ email: 'cto@paylane.dev', confidence: 'VERIFIED' });

    // ── Tailored resume → download PDF ──
    const versionId = job.application.resumeVersionId;
    const pdf = await get(`/resume/versions/${versionId}/download`).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toMatch(/attachment; filename="Alex_Morgan_Resume\.pdf"/);
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');

    // ── Preview email (already drafted by the automation, mirrored to Gmail Drafts) ──
    const draft = job.application.outreach[0];
    expect(draft).toMatchObject({ status: 'DRAFT', kind: 'INITIAL' });
    expect(draft.gmailDraftId).toBeTruthy();
    const preview = (await get(`/outreach/${draft.id}`).expect(200)).body;
    expect(preview.guardrails.allowed).toBe(true);
    expect(preview.outreach.body).toContain('Paylane');

    // ── Approve → send (the Gmail draft itself is sent) ──
    await post(`/outreach/${draft.id}/approve`).expect(200);
    await app.get(QueueService).cancelSend(draft.id);
    expect((await app.get(OutreachService).sendNow(draft.id)).status).toBe('sent');
    const accounts = app.get(EmailAccountsService);
    const account = await prisma.emailAccount.findFirstOrThrow();
    const mailbox = accounts.mailbox(account);
    expect((await accounts.sandbox.listDrafts(mailbox)).find((d) => d.draftId === draft.gmailDraftId)).toBeUndefined();
    const sent = await prisma.outreach.findUniqueOrThrow({ where: { id: draft.id } });
    const thread = await accounts.sandbox.getThread(mailbox, sent.gmailThreadId!);
    expect(thread[0].headers['X-Attachments']).toMatch(/Resume\.pdf/);

    // ── Track: follow-ups on day 4, 9, 16 ──
    const fus = await prisma.followup.findMany({ where: { rootId: draft.id }, orderBy: { sequence: 'asc' } });
    expect(fus).toHaveLength(3);
    const days = fus.map((f) => Math.round((f.scheduledAt.getTime() - sent.sentAt!.getTime()) / 86_400_000));
    expect(days[0]).toBeGreaterThanOrEqual(4);
    expect(days[2]).toBeGreaterThanOrEqual(16);
    expect(days[2]).toBeLessThanOrEqual(17); // anchored to the first email; only the send-window nudges it

    // ── Follow-up #1 is due: drafted (also into Gmail Drafts), approved, sent in the same thread ──
    await prisma.followup.update({ where: { id: fus[0].id }, data: { scheduledAt: new Date(Date.now() - 60_000) } });
    await app.get(FollowupRunnerService).tick();
    const f1 = await prisma.followup.findUniqueOrThrow({ where: { id: fus[0].id }, include: { outreach: true } });
    expect(f1.status).toBe('DRAFT_READY');
    expect(f1.outreach!.gmailDraftId).toBeTruthy();
    await post(`/outreach/${f1.outreachId}/approve`).expect(200);
    await app.get(QueueService).cancelSend(f1.outreachId!);
    expect((await app.get(OutreachService).sendNow(f1.outreachId!)).status).toBe('sent');
    expect((await prisma.outreach.findUniqueOrThrow({ where: { id: f1.outreachId! } })).gmailThreadId).toBe(sent.gmailThreadId);

    // Follow-up #2 drafted early into Gmail, then the recruiter replies.
    const f2 = await prisma.followup.findFirstOrThrow({ where: { rootId: draft.id, sequence: 2 } });
    await post(`/followups/${f2.id}/prepare`).expect(200);
    const f2Draft = (await prisma.followup.findUniqueOrThrow({ where: { id: f2.id }, include: { outreach: true } })).outreach!;
    expect((await accounts.sandbox.listDrafts(mailbox)).some((d) => d.draftId === f2Draft.gmailDraftId)).toBe(true);

    // ── Reply → every pending follow-up cancelled, and its Gmail draft removed ──
    await post('/email/sandbox/simulate', { outreachId: draft.id, kind: 'reply', body: "Hi Prince — let's set up a call this week." }).expect(200);
    const after = await prisma.followup.findMany({ where: { rootId: draft.id }, orderBy: { sequence: 'asc' } });
    expect(after.map((f) => f.status)).toEqual(['SENT', 'CANCELLED', 'CANCELLED']);
    expect((await accounts.sandbox.listDrafts(mailbox)).some((d) => d.draftId === f2Draft.gmailDraftId)).toBe(false);
    expect((await prisma.application.findUniqueOrThrow({ where: { id: job.application.id } })).status).toBe('REPLIED');

    // ── Interview tracking ──
    await post(`/applications/${job.application.id}/interviews`, { stage: 'Technical round', scheduledAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }).expect(201);
    expect((await prisma.application.findUniqueOrThrow({ where: { id: job.application.id } })).status).toBe('INTERVIEW');
    expect((await get('/interviews').expect(200)).body).toHaveLength(1);
  });

  it('detects a draft that was sent directly from Gmail and starts tracking it', async () => {
    const user = await prisma.user.findFirstOrThrow();
    await app.get(DiscoveryService).runAll(user.id, 'manual');
    const o = await prisma.outreach.findFirstOrThrow({ where: { status: 'DRAFT', gmailDraftId: { not: null } } });
    const accounts = app.get(EmailAccountsService);
    const account = await prisma.emailAccount.findFirstOrThrow();
    await accounts.sandbox.sendDraftFromClient(accounts.mailbox(account), o.gmailDraftId!);

    const r = (await post('/email/sync').expect(200)).body;
    expect(r.sentFromMailbox).toBe(1);
    const sent = await prisma.outreach.findUniqueOrThrow({ where: { id: o.id } });
    expect(sent.status).toBe('SENT');
    expect(sent.threadState).toBe('WAITING_FOR_REPLY');
    expect(await prisma.followup.count({ where: { rootId: o.id, status: 'SCHEDULED' } })).toBe(3);
    // The app never sends it a second time.
    expect((await app.get(OutreachService).sendNow(o.id)).status).toBe('already_sent');
  });

  it('uses the uploaded LaTeX resume as the template (design untouched, only order changes)', async () => {
    const up = await agent.post('/api/resume/latex').set('x-csrf-token', csrf).attach('files', Buffer.from(LATEX), 'resume.tex').expect(200);
    expect(up.body.summary.latex.sections).toEqual(['Experience', 'Projects', 'Technical Skills']);
    expect(up.body.compiled).toBe(hasBrowser);
    if (!hasBrowser) expect(up.body.error).toMatch(/playwright install chromium/);

    const user = await prisma.user.findFirstOrThrow();
    await app.get(DiscoveryService).runAll(user.id, 'manual');
    const job = await prisma.job.findFirstOrThrow({ where: { company: { name: 'Paylane' } }, include: { application: true } });
    const tailored = (await post(`/jobs/${job.id}/resume`).expect(200)).body.version;
    expect(tailored.changes.format).toBe('latex');
    const tex = (await get(`/resume/versions/${tailored.id}/tex`).expect(200)).text;
    expect(tex.length).toBe(LATEX.length); // same content, re-ordered
    expect(tex.slice(0, tex.indexOf('\\begin{document}'))).toBe(LATEX.slice(0, LATEX.indexOf('\\begin{document}')));
    expect(tex).not.toBe(LATEX);
    const diff = (await get(`/resume/versions/${tailored.id}/diff`).expect(200)).body;
    expect(diff.lines.some((l: { type: string }) => l.type === 'add')).toBe(true);

    if (hasBrowser) {
      expect(tailored.compileStatus).toBe('ok');
      const pdf = await get(`/resume/versions/${tailored.id}/download`).expect(200);
      expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
    } else {
      // Without a browser engine we say so and refuse to substitute a different resume.
      expect(tailored.compileStatus).toBe('failed');
      await get(`/resume/versions/${tailored.id}/download`).expect(422);
    }
  });
});
