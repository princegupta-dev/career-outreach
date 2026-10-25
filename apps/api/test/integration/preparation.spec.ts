import type { INestApplicationContext } from '@nestjs/common';
import type { Job as BullJob } from 'bullmq';
import { MetricsService } from '../../src/common/metrics.service';
import { PrismaService } from '../../src/common/prisma.service';
import { CompaniesService } from '../../src/modules/companies/companies.service';
import { ContactsService } from '../../src/modules/contacts/contacts.service';
import { JobsService } from '../../src/modules/jobs/jobs.service';
import { PreparationService } from '../../src/modules/preparation/preparation.service';
import { JobProcessingProcessor } from '../../src/modules/queues/processors';
import { QueueService } from '../../src/modules/queues/queues';
import { ResumeService } from '../../src/modules/resume/resume.service';
import { createContext, createUser, flushRedis, resetDatabase } from '../setup/helpers';
import { installMockWeb } from '../setup/mock-web';

const JD =
  'We are hiring a Senior Backend Engineer. You will build payment APIs with Node.js, TypeScript, PostgreSQL, Redis and AWS. ' +
  '4+ years of experience building backend systems with message queues and REST APIs. Remote, open to candidates in India.';

/**
 * "Prepare my application": persisted progress, one workflow per application, retries that skip finished work,
 * and nothing sent without an explicit approval. Mocked internet; the worker is simulated by calling execute().
 */
describe('Application preparation workflow (integration, mocked internet)', () => {
  let ctx: INestApplicationContext;
  let prisma: PrismaService;
  let jobs: JobsService;
  let prep: PreparationService;
  let queues: QueueService;
  let userId: string;
  let web: ReturnType<typeof installMockWeb>;

  beforeAll(async () => {
    ctx = await createContext();
    prisma = ctx.get(PrismaService);
    jobs = ctx.get(JobsService);
    prep = ctx.get(PreparationService);
    queues = ctx.get(QueueService);
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    await prisma.preparationWorkflow.deleteMany();
    await flushRedis();
    userId = (await createUser(prisma)).id;
    web = installMockWeb();
  });
  afterEach(() => {
    web.restore();
    jest.restoreAllMocks();
  });
  afterAll(async () => ctx.close());

  /** A manual job whose company website publishes a hiring inbox (see mock-web). */
  let n = 0;
  const makeJob = async (over: Record<string, unknown> = {}) =>
    // A distinct posting URL each time: jobs with the same URL are (rightly) de-duplicated into one.
    (await jobs.createManual(userId, { title: 'Senior Backend Engineer', companyName: 'AcmeCorp', description: JD, location: 'Remote (Worldwide)', url: `https://acmecorp.com/careers/backend-${++n}`, companyWebsite: 'https://acmecorp.com', ...over })).jobId;

  const appOf = async (jobId: string) => prisma.application.findFirstOrThrow({ where: { jobId } });
  const queued = async (queue: string, name?: string) => (await queues.all()[queue].getJobs(['waiting', 'delayed', 'active'])).filter((j) => !name || j.name === name);
  const run = async (jobId: string) => {
    const v = await prep.get(userId, jobId);
    return prep.execute(v.workflowId!);
  };
  const stepStatus = (v: Awaited<ReturnType<PreparationService['get']>>) => Object.fromEntries(v.steps.map((s) => [s.key, s.status]));

  it('before it starts: nothing exists, nothing is claimed', async () => {
    const jobId = await makeJob();
    const v = await prep.get(userId, jobId);
    expect(v).toMatchObject({ workflowId: null, status: 'NOT_STARTED', statusLabel: 'Not started', review: null });
    expect(v.steps.map((s) => s.statusLabel)).toEqual(Array(5).fill('Not started'));
    expect(await prisma.preparationWorkflow.count()).toBe(0);
  });

  it('happy path: validates, researches, finds a published contact, tailors, drafts — and stops for review without applying or sending', async () => {
    const jobId = await makeJob();
    const started = await prep.start(userId, jobId);
    expect(started.status).toBe('IN_PROGRESS');
    expect((await appOf(jobId)).status).toBe('PREPARING');
    expect(await queued('job-processing', 'prepare')).toHaveLength(1);

    const result = await run(jobId);
    expect(result).toMatchObject({ status: 'READY_FOR_REVIEW', ran: ['VALIDATE', 'COMPANY', 'CONTACT', 'RESUME', 'EMAIL'] });

    const v = await prep.get(userId, jobId);
    expect(v).toMatchObject({ status: 'READY_FOR_REVIEW', statusLabel: 'Ready for review', mode: 'EMAIL' });
    expect(stepStatus(v)).toEqual({ VALIDATE: 'DONE', COMPANY: 'DONE', CONTACT: 'DONE', RESUME: 'DONE', EMAIL: 'DONE' });

    // Job check: a page that loads is "reachable", never "verified open".
    expect(v.review!.job.open).toBe('reachable');
    expect(v.review!.outstandingChecks.join(' ')).toMatch(/can't tell whether it still accepts applications/);
    // Contact: published on the company's own website → verified, with its source.
    expect(v.review!.contact).toMatchObject({ email: 'careers@acmecorp.com', confidence: 'VERIFIED' });
    // Company facts: each unknown is null (not invented), each known fact names its source.
    const funding = v.review!.company.find((f) => f.label === 'Funding')!;
    expect(funding).toMatchObject({ value: null, source: null, asOf: null });
    expect(v.review!.company.find((f) => f.label === 'Website')).toMatchObject({ value: 'https://acmecorp.com', source: 'Job posting (MANUAL)' });
    // Resume: a real PDF was produced and checked; the master resume is untouched.
    expect(v.review!.resume).toMatchObject({ aiAssisted: false });
    expect((await prisma.resumeVersion.count({ where: { jobId } }))).toBe(1);
    // Email: a draft tied to the real recipient — not sent, not approved.
    expect(v.review!.email).toMatchObject({ to: 'careers@acmecorp.com', status: 'DRAFT' });
    expect(v.review!.email!.body).toMatch(/AcmeCorp/);
    expect(v.review!.canApprove).toBe(true);
    expect(v.review!.approveLabel).toBe('Approve and send email');

    // Generating a resume and an email does NOT mean "applied".
    const app = await appOf(jobId);
    expect(app.status).toBe('READY_FOR_REVIEW');
    expect(await prisma.outreach.count({ where: { status: { in: ['APPROVED', 'SENDING', 'SENT'] } } })).toBe(0);
    expect(await queued('email-send')).toHaveLength(0);
    // Events were recorded for auditing.
    expect(v.events.map((e) => e.type)).toEqual(expect.arrayContaining(['started', 'succeeded', 'finished']));
  });

  it('double click: concurrent starts create one workflow, one queued job, one "started" event', async () => {
    const jobId = await makeJob();
    const results = await Promise.all([prep.start(userId, jobId), prep.start(userId, jobId), prep.start(userId, jobId), prep.start(userId, jobId)]);
    expect(new Set(results.map((r) => r.workflowId)).size).toBe(1);
    expect(await prisma.preparationWorkflow.count()).toBe(1);
    expect(await queued('job-processing', 'prepare')).toHaveLength(1);
    const wf = await prisma.preparationWorkflow.findFirstOrThrow();
    expect(await prisma.preparationEvent.count({ where: { workflowId: wf.id, type: 'started' } })).toBe(1);

    // Clicking again while the worker is busy changes nothing.
    await prep.start(userId, jobId);
    expect(await queued('job-processing', 'prepare')).toHaveLength(1);
  });

  it('running the same workflow twice (or clicking after it finished) never makes a second draft, resume or workflow', async () => {
    const jobId = await makeJob();
    await prep.start(userId, jobId);
    const v1 = await prep.get(userId, jobId);
    await prep.execute(v1.workflowId!);
    const discover = jest.spyOn(ctx.get(ContactsService), 'discover');
    const tailor = jest.spyOn(ctx.get(ResumeService), 'tailor');

    const again = await prep.execute(v1.workflowId!); // a duplicate queue delivery
    expect(again).toMatchObject({ status: 'READY_FOR_REVIEW', ran: [] });
    await prep.start(userId, jobId); // the user clicks again after it finished
    expect(discover).not.toHaveBeenCalled();
    expect(tailor).not.toHaveBeenCalled();
    expect(await prisma.outreach.count()).toBe(1);
    expect(await prisma.resumeVersion.count()).toBe(1);
    expect(await prisma.preparationWorkflow.count()).toBe(1);
    expect(await queued('job-processing', 'prepare')).toHaveLength(1); // still just the original queued job, never a second
  });

  it('a lock stops two workers from running the same workflow at once', async () => {
    const jobId = await makeJob();
    await prep.start(userId, jobId);
    const { workflowId } = await prep.get(userId, jobId);
    const [a, b] = await Promise.all([prep.execute(workflowId!), prep.execute(workflowId!)]);
    expect([a, b].filter((r) => 'skipped' in r)).toHaveLength(1);
    expect(await prisma.outreach.count()).toBe(1);
  });

  it('partial failure: the resume step fails, the other steps keep their results, and retrying repeats only the failed step', async () => {
    const jobId = await makeJob();
    const discover = jest.spyOn(ctx.get(ContactsService), 'discover');
    const research = jest.spyOn(ctx.get(CompaniesService), 'research');
    const real = ctx.get(ResumeService).tailor.bind(ctx.get(ResumeService));
    const tailor = jest.spyOn(ctx.get(ResumeService), 'tailor').mockRejectedValueOnce(new Error('LaTeX engine crashed'));

    await prep.start(userId, jobId);
    expect(await run(jobId)).toMatchObject({ status: 'FAILED' });
    const failed = await prep.get(userId, jobId);
    expect(stepStatus(failed)).toEqual({ VALIDATE: 'DONE', COMPANY: 'DONE', CONTACT: 'DONE', RESUME: 'FAILED', EMAIL: 'PENDING' });
    expect(failed.steps.find((s) => s.key === 'RESUME')).toMatchObject({ statusLabel: 'Failed — retry available', error: 'LaTeX engine crashed', attempts: 1 });
    expect(failed.review!.contact?.email).toBe('careers@acmecorp.com'); // successful work is still shown
    expect(failed.review!.canApprove).toBe(false);
    expect((await appOf(jobId)).status).toBe('PREPARING'); // not "ready", not "applied"
    expect(await prisma.outreach.count()).toBe(0); // no half-made draft

    // Approving a half-prepared application is refused.
    await expect(prep.approve(userId, jobId)).rejects.toMatchObject({ status: 409 });

    // Retry just the failed step.
    tailor.mockImplementation(real);
    await prep.retryStep(userId, jobId, 'RESUME');
    const retried = await run(jobId);
    expect(retried).toMatchObject({ status: 'READY_FOR_REVIEW', ran: ['RESUME', 'EMAIL'] });
    expect(discover).toHaveBeenCalledTimes(1); // contact lookup was not repeated
    expect(research).toHaveBeenCalledTimes(1); // neither was company research
    expect(tailor).toHaveBeenCalledTimes(2);
    expect(await prisma.outreach.count()).toBe(1);
    const done = await prep.get(userId, jobId);
    expect(done.steps.find((s) => s.key === 'RESUME')!.attempts).toBe(2);
    expect(done.events.map((e) => e.type)).toEqual(expect.arrayContaining(['failed', 'retried']));
  });

  it('no browser engine on this machine: the user can continue without a tailored resume — the draft has no attachment and says so', async () => {
    const jobId = await makeJob();
    jest.spyOn(ctx.get(ResumeService), 'tailor').mockRejectedValue(new Error('The tailored resume could not be built: Could not start a browser to build the PDF.'));
    await prep.start(userId, jobId);
    expect(await run(jobId)).toMatchObject({ status: 'FAILED' });

    // Only a failed resume step can be skipped.
    await expect(prep.skipStep(userId, jobId, 'COMPANY')).rejects.toMatchObject({ status: 400 });
    await expect(prep.skipStep(userId, jobId, 'RESUME')).resolves.toBeDefined();
    expect(await run(jobId)).toMatchObject({ status: 'READY_FOR_REVIEW', ran: ['EMAIL'] }); // nothing else is repeated

    const v = await prep.get(userId, jobId);
    expect(v.steps.find((s) => s.key === 'RESUME')).toMatchObject({ status: 'DONE', skipped: true });
    expect(v.review!.resume).toBeNull();
    expect(v.review!.email).toMatchObject({ to: 'careers@acmecorp.com', attachResume: false, status: 'DRAFT' });
    expect(v.review!.outstandingChecks.join(' ')).toMatch(/No tailored resume is attached/);
    await expect(prep.skipStep(userId, jobId, 'RESUME')).rejects.toMatchObject({ status: 409 }); // no longer failed

    // Approval needs no PDF when nothing is attached, and still queues exactly one send.
    await prep.approve(userId, jobId);
    expect(await queued('email-send')).toHaveLength(1);
    expect((await prisma.outreach.findFirstOrThrow()).attachResume).toBe(false);
  });

  it('"Tailor again" refreshes the resume and the draft keeps attaching the current version, without a second draft', async () => {
    const jobId = await makeJob();
    await prep.start(userId, jobId);
    await run(jobId);
    const first = await prisma.outreach.findFirstOrThrow();
    const before = (await prisma.application.findFirstOrThrow({ where: { jobId } })).resumeVersionId;
    expect(first.resumeVersionId).toBe(before);

    // The user re-tailors (e.g. after the tailoring rules improved): a new version is made.
    await prisma.resumeVersion.updateMany({ where: { jobId }, data: { inputHash: 'old-rules' } });
    await prep.retryStep(userId, jobId, 'RESUME');
    expect(await run(jobId)).toMatchObject({ status: 'READY_FOR_REVIEW', ran: ['RESUME', 'EMAIL'] });

    const after = (await prisma.application.findFirstOrThrow({ where: { jobId } })).resumeVersionId;
    expect(after).not.toBe(before);
    expect(await prisma.outreach.count()).toBe(1); // still one draft
    expect((await prisma.outreach.findFirstOrThrow()).resumeVersionId).toBe(after); // …attaching the new resume
  });

  it('a failing company lookup does not block the rest (steps are independent where they can be)', async () => {
    const jobId = await makeJob();
    jest.spyOn(ctx.get(CompaniesService), 'research').mockRejectedValue(new Error('site down'));
    await prep.start(userId, jobId);
    const result = await run(jobId);
    expect(result).toMatchObject({ status: 'FAILED', ran: ['VALIDATE', 'COMPANY', 'CONTACT', 'RESUME', 'EMAIL'] });
    const v = await prep.get(userId, jobId);
    expect(stepStatus(v)).toEqual({ VALIDATE: 'DONE', COMPANY: 'FAILED', CONTACT: 'DONE', RESUME: 'DONE', EMAIL: 'DONE' });
  });

  describe('approval safeguards', () => {
    it('only an explicit approval queues the send, exactly once, and the workflow then completes', async () => {
      const jobId = await makeJob();
      await prep.start(userId, jobId);
      await run(jobId);
      expect(await queued('email-send')).toHaveLength(0);

      const approved = await prep.approve(userId, jobId);
      expect(approved).toMatchObject({ status: 'COMPLETED', statusLabel: 'Completed' });
      expect((await appOf(jobId)).status).toBe('APPROVED'); // approved ≠ applied: it becomes Applied only when the email is actually sent
      expect((await prisma.outreach.findFirstOrThrow()).status).toBe('APPROVED');
      expect(await queued('email-send')).toHaveLength(1);
      expect(await prisma.outreach.count({ where: { status: 'SENT' } })).toBe(0);

      // A second click is harmless.
      await prep.approve(userId, jobId);
      expect(await queued('email-send')).toHaveLength(1);
      await expect(prep.retryStep(userId, jobId, 'RESUME')).rejects.toMatchObject({ status: 409 });
    });

    it('approval before the workflow is ready is refused', async () => {
      const jobId = await makeJob();
      await expect(prep.approve(userId, jobId)).rejects.toMatchObject({ status: 409 });
      await prep.start(userId, jobId); // queued but not run yet
      await expect(prep.approve(userId, jobId)).rejects.toMatchObject({ status: 409 });
      expect(await queued('email-send')).toHaveLength(0);
    });

    it('the existing send safeguards still apply: a suppressed recipient cannot be approved, and nothing changes', async () => {
      const jobId = await makeJob();
      await prisma.suppression.create({ data: { userId, value: 'acmecorp.com', kind: 'domain', reason: 'Asked not to contact' } });
      await prep.start(userId, jobId);
      await run(jobId);
      await expect(prep.approve(userId, jobId)).rejects.toMatchObject({ status: 422 });
      expect((await appOf(jobId)).status).toBe('READY_FOR_REVIEW');
      expect((await prep.get(userId, jobId)).status).toBe('READY_FOR_REVIEW');
      expect((await prisma.outreach.findFirstOrThrow()).status).toBe('DRAFT');
      expect(await queued('email-send')).toHaveLength(0);
    });
  });

  describe('no contact, unverified contact', () => {
    it('with no public contact it prepares a checklist, never an invented email, and approval is only a record', async () => {
      const jobId = await makeJob({ companyName: 'Nowhere Labs', companyWebsite: 'https://nowhere.test', url: 'https://nowhere.test/jobs/1' });
      await prep.start(userId, jobId);
      expect(await run(jobId)).toMatchObject({ status: 'READY_FOR_REVIEW' });
      const v = await prep.get(userId, jobId);
      expect(v.mode).toBe('EXTERNAL');
      expect(v.review!.contact).toBeNull();
      expect(v.review!.email).toBeNull();
      expect(v.review!.fallbackRoutes.map((r) => r.label)).toEqual(expect.arrayContaining(['Apply through the official posting', 'Find a technical recruiter (LinkedIn search)']));
      expect(v.review!.checklist!.join('\n')).toMatch(/Open the official posting/);
      expect(v.review!.outstandingChecks.join(' ')).toMatch(/No public hiring contact was found/);
      expect(v.review!.approveLabel).toMatch(/apply on the company site/);
      expect(await prisma.contact.count()).toBe(0);
      expect(await prisma.outreach.count()).toBe(0);

      await prep.approve(userId, jobId);
      expect((await appOf(jobId)).status).toBe('APPROVED');
      expect(await queued('email-send')).toHaveLength(0); // nothing to send
      expect((await prep.get(userId, jobId)).steps.find((s) => s.key === 'EMAIL')!.summary).toMatch(/checklist/);

      // Applied only when the user says so.
      const { lifecycle } = await prep.lifecycle(userId, (await appOf(jobId)).id, 'mark_applied');
      expect(lifecycle).toMatchObject({ stage: 'APPLIED', stageLabel: 'Applied' });
    });

    it('an unverified address waits for the user; confirming it lets the draft proceed (and says it is unverified)', async () => {
      const jobId = await makeJob({ companyName: 'Hunter Co', companyWebsite: 'https://nowhere.test', url: 'https://nowhere.test/jobs/2' });
      const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
      const guess = await prisma.contact.create({ data: { userId, companyId: job.companyId, name: 'Pat Guess', roleCategory: 'RECRUITER', email: 'pat@nowhere.test', emailNormalized: 'pat@nowhere.test', source: 'hunter.io', confidence: 'LIKELY' } });
      await prisma.application.update({ where: { jobId }, data: { contactId: guess.id } });

      await prep.start(userId, jobId);
      expect(await run(jobId)).toMatchObject({ status: 'NEEDS_INPUT' });
      const waiting = await prep.get(userId, jobId);
      expect(stepStatus(waiting)).toEqual({ VALIDATE: 'DONE', COMPANY: 'DONE', CONTACT: 'NEEDS_INPUT', RESUME: 'DONE', EMAIL: 'PENDING' });
      expect(waiting.steps.find((s) => s.key === 'CONTACT')).toMatchObject({ statusLabel: 'Needs your input', needs: { kind: 'confirm_contact', contactId: guess.id } });
      expect(await prisma.outreach.count()).toBe(0); // no draft to an unconfirmed address

      await prep.confirmStep(userId, jobId, 'CONTACT');
      expect(await run(jobId)).toMatchObject({ status: 'READY_FOR_REVIEW' });
      const ready = await prep.get(userId, jobId);
      expect(ready.review!.email!.to).toBe('pat@nowhere.test');
      expect(ready.review!.outstandingChecks.join(' ')).toMatch(/recipient is not verified/);
      await expect(prep.confirmStep(userId, jobId, 'CONTACT')).rejects.toMatchObject({ status: 409 }); // nothing left to confirm
    });
  });

  describe('is the job still open?', () => {
    it('a posting that is gone from its company board stops the run until the user decides', async () => {
      const jobId = await makeJob({ companyName: 'GoneCo' });
      await prisma.job.update({ where: { id: jobId }, data: { provider: 'GREENHOUSE', externalId: 'goneco:99', url: 'https://boards.greenhouse.io/goneco/jobs/99' } });
      const discover = jest.spyOn(ctx.get(ContactsService), 'discover');
      const fetchMock = global.fetch as jest.Mock;
      const impl = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('boards-api.greenhouse.io/v1/boards/goneco')) return new Response('{}', { status: 404 });
        return impl(input, init);
      });

      await prep.start(userId, jobId);
      expect(await run(jobId)).toMatchObject({ status: 'NEEDS_INPUT', ran: ['VALIDATE'] });
      const v = await prep.get(userId, jobId);
      expect(v.steps[0]).toMatchObject({ key: 'VALIDATE', status: 'NEEDS_INPUT', needs: { kind: 'confirm_open' } });
      expect(discover).not.toHaveBeenCalled(); // no point finding contacts for a closed job

      await prep.confirmStep(userId, jobId, 'VALIDATE');
      expect(await run(jobId)).toMatchObject({ status: 'READY_FOR_REVIEW' });
      expect((await prep.get(userId, jobId)).review!.outstandingChecks.join(' ')).toMatch(/no longer appears on the company board/);
    });

    it('a still-listed board posting is reported as listed; a source we cannot check is reported as unverified, not open', async () => {
      const listed = await makeJob({ title: 'Platform Engineer', companyName: 'ListedCo' });
      await prisma.job.update({ where: { id: listed }, data: { provider: 'GREENHOUSE', externalId: 'listedco:7', url: 'https://boards.greenhouse.io/listedco/jobs/7' } });
      const fetchMock = global.fetch as jest.Mock;
      const impl = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/boards/listedco')) return new Response(JSON.stringify({ name: 'ListedCo' }), { status: 200 });
        if (url.endsWith('/boards/listedco/jobs/7')) return new Response(JSON.stringify({ id: 7, title: 'Platform Engineer', absolute_url: 'https://boards.greenhouse.io/listedco/jobs/7', location: { name: 'Remote' }, content: '&lt;p&gt;x&lt;/p&gt;' }), { status: 200 });
        return impl(input, init);
      });
      await prep.start(userId, listed);
      await run(listed);
      expect((await prep.get(userId, listed)).review!.job.open).toBe('listed');

      const unknown = await makeJob({ title: 'Backend Developer', companyName: 'PastedCo', url: null, companyWebsite: null });
      await prep.start(userId, unknown);
      await run(unknown);
      const v = await prep.get(userId, unknown);
      expect(v.review!.job.open).toBe('unverified');
      expect(v.review!.outstandingChecks.join(' ')).toMatch(/couldn't confirm the posting is still open/);
    });
  });

  describe('skipping, restarting, and crashes', () => {
    it('skipping a job mid-preparation stops the worker at the next step and cancels any draft', async () => {
      const jobId = await makeJob();
      await prep.start(userId, jobId);
      const appId = (await appOf(jobId)).id;
      await prep.lifecycle(userId, appId, 'skip');
      const result = await run(jobId);
      expect(result).toMatchObject({ ran: [] });
      expect((await appOf(jobId)).status).toBe('SKIPPED');
      expect(await prisma.outreach.count()).toBe(0);

      // A finished draft is cancelled when the job is skipped later.
      const other = await makeJob({ title: 'Staff Backend Engineer' });
      await prep.start(userId, other);
      await run(other);
      expect((await prisma.outreach.findFirstOrThrow({ where: { application: { jobId: other } } })).status).toBe('DRAFT');
      await prep.lifecycle(userId, (await appOf(other)).id, 'skip');
      expect((await prisma.outreach.findFirstOrThrow({ where: { application: { jobId: other } } })).status).toBe('CANCELLED');
      await expect(prep.start(userId, other)).rejects.toMatchObject({ status: 409 }); // restore first
      await prep.lifecycle(userId, (await appOf(other)).id, 'restore');
      expect((await appOf(other)).status).toBe('SHORTLISTED');
    });

    it('lifecycle actions are validated with plain-language errors', async () => {
      const jobId = await makeJob();
      const appId = (await appOf(jobId)).id;
      await prep.lifecycle(userId, appId, 'shortlist');
      expect((await appOf(jobId)).status).toBe('SHORTLISTED');
      await prep.lifecycle(userId, appId, 'skip');
      await expect(prep.lifecycle(userId, appId, 'mark_applied')).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/while the job is "skipped"/) });
      await prep.lifecycle(userId, appId, 'archive');
      expect((await appOf(jobId)).status).toBe('CLOSED');
    });

    it('a run whose worker died is picked up again, and a step left "running" is retried', async () => {
      const jobId = await makeJob();
      await prep.start(userId, jobId);
      const wf = await prisma.preparationWorkflow.findFirstOrThrow();
      const steps = wf.steps as Record<string, object>;
      await prisma.preparationWorkflow.update({
        where: { id: wf.id },
        data: { heartbeatAt: new Date(Date.now() - 11 * 60_000), steps: { ...steps, VALIDATE: { status: 'RUNNING', attempts: 1 } } },
      });
      await prep.start(userId, jobId); // stale heartbeat → resumable
      expect((await prisma.preparationEvent.count({ where: { workflowId: wf.id, type: 'resumed' } }))).toBe(1);
      expect(await run(jobId)).toMatchObject({ status: 'READY_FOR_REVIEW' });
      expect((await prep.get(userId, jobId)).steps[0].attempts).toBe(2);
    });

    it('a run nothing ever picked up can be restarted after 30 seconds; one a worker is actively touching cannot', async () => {
      const jobId = await makeJob();
      await prep.start(userId, jobId);
      const wf = await prisma.preparationWorkflow.findFirstOrThrow();
      const twoMinutesAgo = new Date(Date.now() - 120_000);

      // A worker advanced the heartbeat 5s after start: it is alive, so a second click must not restart it.
      await prisma.preparationWorkflow.update({ where: { id: wf.id }, data: { startedAt: twoMinutesAgo, heartbeatAt: new Date(twoMinutesAgo.getTime() + 5000) } });
      await prep.start(userId, jobId);
      expect(await prisma.preparationEvent.count({ where: { workflowId: wf.id, type: 'resumed' } })).toBe(0);

      // Never picked up (heartbeat == start) and older than 30s: restartable, once even under concurrent clicks.
      await prisma.preparationWorkflow.update({ where: { id: wf.id }, data: { startedAt: twoMinutesAgo, heartbeatAt: twoMinutesAgo } });
      await Promise.all([prep.start(userId, jobId), prep.start(userId, jobId), prep.start(userId, jobId)]);
      expect(await prisma.preparationEvent.count({ where: { workflowId: wf.id, type: 'resumed' } })).toBe(1);
      expect(await run(jobId)).toMatchObject({ status: 'READY_FOR_REVIEW' });
    });

    it('if the run itself crashes, the workflow becomes "failed — retry available" instead of staying "in progress" forever', async () => {
      const jobId = await makeJob();
      await prep.start(userId, jobId);
      const { workflowId } = await prep.get(userId, jobId);
      jest.spyOn(prisma.application, 'findFirstOrThrow').mockRejectedValueOnce(new Error('database went away'));
      expect(await prep.execute(workflowId!)).toMatchObject({ status: 'FAILED' });
      const v = await prep.get(userId, jobId);
      expect(v).toMatchObject({ status: 'FAILED', statusLabel: 'Failed — retry available' });
      expect(v.events[0]).toMatchObject({ type: 'failed', message: expect.stringMatching(/stopped unexpectedly: database went away/) });
      // Clicking again recovers.
      await prep.start(userId, jobId);
      expect(await run(jobId)).toMatchObject({ status: 'READY_FOR_REVIEW' });
    });

    it('tells the user when nothing has picked the job up (worker not running)', async () => {
      const jobId = await makeJob();
      await prep.start(userId, jobId);
      await prisma.preparationWorkflow.updateMany({ data: { startedAt: new Date(Date.now() - 60_000) } });
      expect((await prep.get(userId, jobId)).stalledHint).toMatch(/background worker/);
    });
  });

  it('the worker routes a "prepare" job on the existing job-processing queue to the workflow', async () => {
    const jobId = await makeJob();
    await prep.start(userId, jobId);
    const [queuedJob] = await queued('job-processing', 'prepare');
    const processor = new JobProcessingProcessor(ctx.get(MetricsService), jobs, prep);
    await processor.process({ ...queuedJob, queueName: 'job-processing', attemptsMade: 0, data: queuedJob.data } as unknown as BullJob);
    expect((await prep.get(userId, jobId)).status).toBe('READY_FOR_REVIEW');
  });

  describe('jobs list: needs-action first, with filters', () => {
    it('puts jobs waiting for the user first and filters by stage, source, size and location', async () => {
      const titles = ['Replied Role', 'Review Role', 'Shortlisted Role', 'Fresh Role', 'Skipped Role'];
      const ids: string[] = [];
      for (const t of titles) ids.push(await makeJob({ title: `Senior Backend Engineer ${t}`, description: `${JD} Unique marker ${t}.` }));
      const set = (i: number, status: 'REPLIED' | 'READY_FOR_REVIEW' | 'SHORTLISTED' | 'DISCOVERED' | 'SKIPPED') => prisma.application.update({ where: { jobId: ids[i] }, data: { status } });
      await Promise.all([set(0, 'REPLIED'), set(1, 'READY_FOR_REVIEW'), set(2, 'SHORTLISTED'), set(3, 'DISCOVERED'), set(4, 'SKIPPED')]);

      const byPriority = await jobs.list(userId, { sort: 'priority' });
      expect(byPriority.items.map((j) => j.title.replace('Senior Backend Engineer ', ''))).toEqual(['Replied Role', 'Review Role', 'Shortlisted Role', 'Fresh Role', 'Skipped Role']);
      expect(byPriority.items[0].lifecycle).toMatchObject({ stage: 'REPLIED', label: 'Respond to reply', needsAction: true });
      expect(byPriority.items[4].lifecycle).toMatchObject({ stage: 'SKIPPED', needsAction: false });
      expect(byPriority.items[0].verdict).toMatchObject({ label: expect.any(String) });

      const action = await jobs.list(userId, { needsAction: true, sort: 'priority' });
      expect(action.items.map((j) => j.lifecycle?.stage)).not.toContain('SKIPPED');
      expect(action.total).toBe(4);

      expect((await jobs.list(userId, { stage: 'READY_FOR_REVIEW' })).items.map((j) => j.title)).toEqual([expect.stringContaining('Review Role')]);
      expect((await jobs.list(userId, { source: 'GREENHOUSE' })).total).toBe(0);
      expect((await jobs.list(userId, { source: 'MANUAL' })).total).toBe(5);
      expect((await jobs.list(userId, { location: 'remote' })).total).toBe(5);
      expect((await jobs.list(userId, { location: 'india' })).total).toBe(0);
      expect((await jobs.list(userId, { companySize: 'UNKNOWN' })).total).toBe(5);
      expect((await jobs.list(userId, { companySize: 'GROWTH_STARTUP' })).total).toBe(0);
      // Pages stay stable and sorted across the page boundary.
      const p1 = await jobs.list(userId, { sort: 'priority', pageSize: 2, page: 1 });
      const p2 = await jobs.list(userId, { sort: 'priority', pageSize: 2, page: 2 });
      expect([...p1.items, ...p2.items].map((j) => j.id)).toEqual(byPriority.items.slice(0, 4).map((j) => j.id));
    });

    it('the job page data carries the verdict, the lifecycle, and facts with unknowns marked', async () => {
      const jobId = await makeJob();
      const d = await jobs.get(userId, jobId);
      expect(d.summary).toMatchObject({ verdictLabel: expect.any(String), facts: { salary: { known: false }, companySize: { known: false } } });
      expect(d.lifecycle).toMatchObject({ stage: 'DISCOVERED' });
      expect(d.summary.toVerify).toEqual(expect.arrayContaining(["Salary isn't disclosed.", 'Company size is unknown.']));
    });
  });
});
