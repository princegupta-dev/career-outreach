import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit.service';
import { DomainError } from '../../common/http';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import { lifecycleOf, LifecycleAction, STAGE_LABEL, stageOf, WorkflowStatus } from '../../domain/applications/lifecycle';
import { InvalidTransitionError } from '../../domain/applications/state-machine';
import {
  deriveStatus,
  initialSteps,
  isStepKey,
  normalizeSteps,
  resetFrom,
  runnableSteps,
  STEP_KEYS,
  STEP_LABEL,
  STEP_STATUS_LABEL,
  StepKey,
  StepState,
  Steps,
  WORKFLOW_STATUS_LABEL,
} from '../../domain/preparation/steps';
import { httpFetch, isAllowedByRobots } from '../../providers/http';
import { ApplicationsService } from '../applications/applications.service';
import { AiService } from '../ai/ai.service';
import { CompaniesService, CompanyFact } from '../companies/companies.service';
import { ContactsService } from '../contacts/contacts.service';
import { JobsService } from '../jobs/jobs.service';
import { OutreachService } from '../outreach/outreach.service';
import { QueueService } from '../queues/queues';
import { ResumeService } from '../resume/resume.service';

/** A run whose heartbeat is older than this is assumed dead (worker crashed) and may be resumed. */
const STALE_HEARTBEAT_MS = 10 * 60_000;
/** A run nothing has touched for this long (no step ever started) is considered not picked up, and may be restarted. */
const NOT_PICKED_UP_MS = 30_000;
/** Applications in these statuses may be prepared; anything later has already left the preparation stage. */
const PREPARABLE = ['DISCOVERED', 'QUALIFIED', 'SHORTLISTED', 'CONTACT_FOUND', 'RESUME_READY', 'EMAIL_READY', 'PREPARING', 'READY_FOR_REVIEW'];
/** If the user skips or archives mid-run, the worker stops at the next step. */
const ABANDONED = ['SKIPPED', 'CLOSED', 'REJECTED', 'OFFER', 'INTERVIEW', 'REPLIED', 'EMAIL_SENT', 'WAITING_FOR_REPLY', 'FOLLOWUP_SCHEDULED', 'APPLIED', 'APPROVED'];

type Json = Prisma.InputJsonValue;
type Result = { status: 'DONE' | 'NEEDS_INPUT'; summary: string; data?: Record<string, unknown>; needs?: StepState['needs'] };

/** A fact about the company with where and when we learned it. `value: null` means unknown — never a guess. */
export interface CompanyFactView {
  label: string;
  value: string | null;
  source: string | null;
  sourceUrl: string | null;
  asOf: string | null;
}

export interface PreparationView {
  workflowId: string | null;
  status: WorkflowStatus;
  statusLabel: string;
  mode: 'EMAIL' | 'EXTERNAL' | null;
  steps: Array<{
    key: StepKey;
    label: string;
    status: StepState['status'];
    statusLabel: string;
    summary: string | null;
    error: string | null;
    attempts: number;
    needs: StepState['needs'] | null;
    finishedAt: string | null;
    /** The user chose to continue without this step's result (only the resume step can be skipped). */
    skipped: boolean;
  }>;
  /** Set when a run was started but nothing has happened for a while (usually: the background worker is not running). */
  stalledHint: string | null;
  review: null | {
    job: { open: string; note: string; checkedAt: string | null; location: string };
    company: CompanyFactView[];
    contact: { id: string; name: string; role: string | null; email: string; confidence: string; source: string; sourceUrl: string | null } | null;
    fallbackRoutes: Array<{ label: string; url: string }>;
    resume: { versionId: string; previewUrl: string; downloadUrl: string; aiAssisted: boolean; reused: boolean; changes: number; gaps: string[] } | null;
    email: { id: string; to: string; subject: string; body: string; status: string; attachResume: boolean; warnings: string[] } | null;
    checklist: string[] | null;
    outstandingChecks: string[];
    canApprove: boolean;
    approveLabel: string;
  };
  events: Array<{ id: string; step: string | null; type: string; message: string; createdAt: string }>;
}

function isPublicHttpUrl(raw: string | null | undefined): raw is string {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) return false;
    return !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(u.hostname) && !u.hostname.endsWith('.internal');
  } catch {
    return false;
  }
}

const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

@Injectable()
export class PreparationService {
  private readonly logger = new Logger(PreparationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly applications: ApplicationsService,
    private readonly jobs: JobsService,
    private readonly companies: CompaniesService,
    private readonly contacts: ContactsService,
    private readonly resumes: ResumeService,
    private readonly outreach: OutreachService,
    private readonly queues: QueueService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly ai: AiService,
  ) {}

  // ─── Loading ───────────────────────────────────────────────────────────────

  private async load(userId: string, jobId: string) {
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, userId, deletedAt: null },
      include: { company: true, application: { include: { contact: true, workflow: true } } },
    });
    if (!job) throw new NotFoundException('Job not found');
    if (!job.application) throw new DomainError('This job has no application to prepare.', 409);
    const { application, ...rest } = job;
    return { job: rest, app: application, wf: application.workflow };
  }
  private async createWorkflow(userId: string, applicationId: string) {
    // Unique per application: a concurrent create from a double click resolves to the same row.
    return this.prisma.preparationWorkflow.upsert({
      where: { applicationId },
      create: { userId, applicationId, steps: initialSteps() as unknown as Json },
      update: {},
    });
  }

  private async event(workflowId: string, type: string, message: string, step?: StepKey, metadata?: Record<string, unknown>) {
    await this.prisma.preparationEvent.create({ data: { workflowId, type, message, step: step ?? null, metadata: (metadata ?? undefined) as Json | undefined } });
  }

  // ─── Reading ───────────────────────────────────────────────────────────────

  async get(userId: string, jobId: string): Promise<PreparationView> {
    return this.view(userId, await this.load(userId, jobId));
  }

  private async view(userId: string, L: Awaited<ReturnType<PreparationService['load']>>): Promise<PreparationView> {
    const { wf } = L;
    const steps = normalizeSteps(wf?.steps);
    const status = (wf?.status ?? 'NOT_STARTED') as WorkflowStatus;
    const events = wf ? await this.prisma.preparationEvent.findMany({ where: { workflowId: wf.id }, orderBy: { createdAt: 'desc' }, take: 30 }) : [];

    const untouched = Object.values(steps).every((s) => s.status === 'PENDING');
    const stalledHint =
      wf && status === 'IN_PROGRESS' && untouched && wf.startedAt && Date.now() - wf.startedAt.getTime() > 30_000
        ? 'Nothing has picked this up yet. Preparation runs in the background worker — make sure it is running (npm run dev:worker), then restart it here.'
        : null;

    const showReview = !!wf && (status === 'READY_FOR_REVIEW' || status === 'COMPLETED' || Object.values(steps).some((s) => s.status === 'DONE'));
    return {
      workflowId: wf?.id ?? null,
      status,
      statusLabel: WORKFLOW_STATUS_LABEL[status],
      mode: (wf?.mode as 'EMAIL' | 'EXTERNAL' | null) ?? null,
      steps: STEP_KEYS.map((key) => ({
        key,
        label: STEP_LABEL[key],
        status: steps[key].status,
        statusLabel: STEP_STATUS_LABEL[steps[key].status],
        summary: steps[key].summary ?? null,
        error: steps[key].error ?? null,
        attempts: steps[key].attempts,
        needs: steps[key].needs ?? null,
        finishedAt: steps[key].finishedAt ?? null,
        skipped: !!(steps[key].data as { skipped?: boolean } | undefined)?.skipped,
      })),
      stalledHint,
      review: showReview ? await this.buildReview(userId, L, steps, status) : null,
      events: events.map((e) => ({ id: e.id, step: e.step, type: e.type, message: e.message, createdAt: e.createdAt.toISOString() })),
    };
  }

  private async buildReview(userId: string, L: Awaited<ReturnType<PreparationService['load']>>, steps: Steps, status: WorkflowStatus): Promise<NonNullable<PreparationView['review']>> {
    const { app } = L;
    const v = steps.VALIDATE.data as { open?: string; note?: string; checkedAt?: string; location?: string; missing?: string[] } | undefined;
    const c = steps.CONTACT.data as { contactId?: string; routes?: Array<{ label: string; url: string }> } | undefined;
    const r = steps.RESUME.data as { versionId?: string; aiAssisted?: boolean; reused?: boolean; changes?: number; gaps?: string[] } | undefined;
    const e = steps.EMAIL.data as { mode?: string; outreachId?: string; checklist?: string[] } | undefined;

    const contact = c?.contactId ? await this.prisma.contact.findFirst({ where: { id: c.contactId, userId } }) : null;
    const email = e?.outreachId
      ? await this.prisma.outreach.findFirst({ where: { id: e.outreachId, userId }, select: { id: true, toEmail: true, subject: true, body: true, status: true, attachResume: true, warnings: true } })
      : null;
    const draftWarnings = ((email?.warnings as { items?: string[] } | null)?.items ?? []).filter(Boolean);

    const outstanding: string[] = [];
    if (v?.open === 'unverified') outstanding.push(`We couldn't confirm the posting is still open: ${v.note ?? 'this source cannot be checked automatically'}.`);
    if (v?.open === 'reachable') outstanding.push("The posting page loads, but we can't tell whether it still accepts applications.");
    if (v?.open === 'closed') outstanding.push('The posting no longer appears on the company board (you chose to continue).');
    if (v?.location && v.location !== 'open') outstanding.push(v.location === 'restricted' ? 'The posting may be restricted to a region that excludes India.' : "The posting doesn't say whether candidates in India are eligible.");
    if (steps.CONTACT.status === 'DONE' && !contact) outstanding.push('No public hiring contact was found, so no email was drafted — apply through the official posting.');
    if (contact && contact.confidence !== 'VERIFIED') outstanding.push(`The recipient is not verified (${contact.source}). You confirmed using them.`);
    if ((steps.RESUME.data as { skipped?: boolean } | undefined)?.skipped) outstanding.push('No tailored resume is attached — you chose to continue without one. Use your own resume when you apply.');
    for (const g of r?.gaps ?? []) outstanding.push(`Not in your resume: ${g}.`);
    for (const w of draftWarnings) outstanding.push(w);

    const hasEmail = !!email && ['DRAFT', 'APPROVED', 'SENDING', 'SENT'].includes(email.status);
    // Approved by any route (this workflow, or the email editor in the job's details): never offer a second approval.
    const approved =
      status === 'COMPLETED' ||
      ['APPROVED', 'APPLIED', 'EMAIL_SENT', 'WAITING_FOR_REPLY', 'FOLLOWUP_SCHEDULED'].includes(app.status) ||
      (!!email && ['APPROVED', 'SENDING', 'SENT'].includes(email.status));
    return {
      job: { open: v?.open ?? 'unverified', note: v?.note ?? '', checkedAt: v?.checkedAt ?? null, location: v?.location ?? 'unknown' },
      company: ((steps.COMPANY.data as { facts?: CompanyFactView[] } | undefined)?.facts ?? []) as CompanyFactView[],
      contact: contact?.email ? { id: contact.id, name: contact.name, role: contact.role, email: contact.email, confidence: contact.confidence, source: contact.source, sourceUrl: contact.sourceUrl } : null,
      fallbackRoutes: c?.routes ?? [],
      resume: r?.versionId
        ? { versionId: r.versionId, previewUrl: `/api/resume/versions/${r.versionId}/pdf`, downloadUrl: `/api/resume/versions/${r.versionId}/download`, aiAssisted: !!r.aiAssisted, reused: !!r.reused, changes: r.changes ?? 0, gaps: r.gaps ?? [] }
        : null,
      email: email ? { id: email.id, to: email.toEmail, subject: email.subject, body: email.body, status: email.status, attachResume: email.attachResume, warnings: draftWarnings } : null,
      checklist: e?.checklist ?? null,
      outstandingChecks: outstanding,
      canApprove: status === 'READY_FOR_REVIEW' && !approved,
      approveLabel: hasEmail ? 'Approve and send email' : "Approve — I'll apply on the company site",
    };
  }

  // ─── Starting, retrying, confirming ─────────────────────────────────────────

  /**
   * "Prepare my application". Safe to click twice: the workflow row is unique per application and only
   * one request wins the claim below, so a second click never starts a second run or a second draft.
   */
  async start(userId: string, jobId: string): Promise<PreparationView> {
    const L = await this.load(userId, jobId);
    if (!PREPARABLE.includes(L.app.status)) {
      throw new DomainError(`This job is already ${STAGE_LABEL[stageOf(L.app.status)].toLowerCase()}, so it can't be prepared again.`, 409);
    }
    const wf = L.wf ?? (await this.createWorkflow(userId, L.app.id));
    if (wf.status === 'READY_FOR_REVIEW' || wf.status === 'COMPLETED') return this.get(userId, jobId);
    // Waiting for the user (nothing left to run): report instead of starting an empty run.
    if (wf.status !== 'NOT_STARTED' && wf.status !== 'IN_PROGRESS' && runnableSteps(normalizeSteps(wf.steps)).length === 0) return this.get(userId, jobId);
    // Started but never picked up (worker down, or the queued job failed): allow a restart instead of waiting out the long timeout.
    const notPickedUp =
      wf.status === 'IN_PROGRESS' && !!wf.startedAt && !!wf.heartbeatAt && wf.heartbeatAt.getTime() - wf.startedAt.getTime() < 1500 && Date.now() - wf.heartbeatAt.getTime() > NOT_PICKED_UP_MS;
    await this.claimAndEnqueue(userId, wf.id, L.app.id, wf.startedAt ? 'resumed' : 'started', notPickedUp ? wf.heartbeatAt : null);
    return this.get(userId, jobId);
  }

  /** Atomically move the workflow to IN_PROGRESS (only one caller succeeds) and queue the worker job. */
  private async claimAndEnqueue(userId: string, workflowId: string, applicationId: string, why: string, notPickedUpAt: Date | null = null): Promise<boolean> {
    const staleBefore = new Date(Date.now() - STALE_HEARTBEAT_MS);
    const claimed = await this.prisma.preparationWorkflow.updateMany({
      where: {
        id: workflowId,
        OR: [
          { status: { in: ['NOT_STARTED', 'FAILED', 'NEEDS_INPUT', 'READY_FOR_REVIEW'] } },
          { status: 'IN_PROGRESS', OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: staleBefore } }] },
          // Compare-and-set on the heartbeat we saw: if a worker touched it meanwhile, this no longer matches.
          ...(notPickedUpAt ? [{ status: 'IN_PROGRESS', heartbeatAt: notPickedUpAt }] : []),
        ],
      },
      data: { status: 'IN_PROGRESS', finishedAt: null, heartbeatAt: new Date(), startedAt: new Date() },
    });
    if (claimed.count === 0) return false; // someone else is already running it
    await this.event(workflowId, why, why === 'started' ? 'Preparation started.' : 'Preparation resumed.');
    await this.applications.moveForWorkflow(applicationId, 'PREPARING');
    await this.queues.prepareApplication({ userId, workflowId });
    await this.audit.log('preparation.started', { userId, entityType: 'application', entityId: applicationId, metadata: { workflowId, why } });
    return true;
  }

  /** Retry one step (and only what depends on it). Finished, independent steps are kept as they are. */
  async retryStep(userId: string, jobId: string, stepKey: string): Promise<PreparationView> {
    if (!isStepKey(stepKey)) throw new DomainError(`Unknown step "${stepKey}"`, 400);
    const L = await this.load(userId, jobId);
    const wf = L.wf;
    if (!wf) throw new DomainError('Nothing to retry — this job has not been prepared yet.', 409);
    if (wf.status === 'COMPLETED' || !PREPARABLE.includes(L.app.status)) throw new DomainError('This application was already approved, so its steps can no longer be re-run.', 409);
    if (wf.status === 'IN_PROGRESS' && wf.heartbeatAt && Date.now() - wf.heartbeatAt.getTime() < STALE_HEARTBEAT_MS) throw new DomainError('Preparation is still running. Try again in a moment.', 409);
    const steps = resetFrom(normalizeSteps(wf.steps), stepKey);
    await this.prisma.preparationWorkflow.update({ where: { id: wf.id }, data: { steps: steps as unknown as Json, status: 'NOT_STARTED' } });
    await this.event(wf.id, 'retried', `Retrying "${STEP_LABEL[stepKey]}".`, stepKey);
    await this.claimAndEnqueue(userId, wf.id, L.app.id, 'resumed');
    return this.get(userId, jobId);
  }

  /** The user's answer to a "needs your input" step. */
  async confirmStep(userId: string, jobId: string, stepKey: string): Promise<PreparationView> {
    if (!isStepKey(stepKey)) throw new DomainError(`Unknown step "${stepKey}"`, 400);
    const L = await this.load(userId, jobId);
    const wf = L.wf;
    const steps = normalizeSteps(wf?.steps);
    const step = steps[stepKey];
    if (!wf || step.status !== 'NEEDS_INPUT' || !step.needs) throw new DomainError('That step is not waiting for your input.', 409);
    if (step.needs.kind === 'confirm_open') {
      steps[stepKey] = { ...step, status: 'DONE', needs: undefined, summary: 'You chose to continue although the posting no longer appears to be listed.', data: { ...step.data, acknowledgedClosed: true } };
    } else {
      // Re-run the contact step; it will now accept the confirmed contact.
      steps[stepKey] = { ...step, status: 'PENDING', needs: undefined, data: { ...step.data, confirmedContactId: step.needs.contactId } };
    }
    await this.prisma.preparationWorkflow.update({ where: { id: wf.id }, data: { steps: steps as unknown as Json, status: 'NOT_STARTED' } });
    await this.event(wf.id, 'confirmed', `You confirmed: ${step.needs.message}`, stepKey);
    await this.claimAndEnqueue(userId, wf.id, L.app.id, 'resumed');
    return this.get(userId, jobId);
  }

  /**
   * "Continue without a tailored resume". Only for a failed resume step — typically because no TeX engine is
   * installed here. Nothing is substituted or faked: the draft simply goes without an attachment, and the
   * summary says so. The user can try tailoring again later.
   */
  async skipStep(userId: string, jobId: string, stepKey: string): Promise<PreparationView> {
    if (stepKey !== 'RESUME') throw new DomainError('Only the resume step can be skipped.', 400);
    const L = await this.load(userId, jobId);
    const wf = L.wf;
    const steps = normalizeSteps(wf?.steps);
    if (!wf || steps.RESUME.status !== 'FAILED') throw new DomainError('The resume step has not failed, so there is nothing to skip.', 409);
    if (wf.status === 'COMPLETED' || !PREPARABLE.includes(L.app.status)) throw new DomainError('This application was already approved.', 409);
    steps.RESUME = {
      ...steps.RESUME,
      status: 'DONE',
      finishedAt: new Date().toISOString(),
      summary: 'Skipped — continuing without a tailored resume. Use your own resume when you apply.',
      data: { skipped: true, reason: steps.RESUME.error },
      error: undefined,
    };
    await this.prisma.preparationWorkflow.update({ where: { id: wf.id }, data: { steps: steps as unknown as Json, status: 'NOT_STARTED' } });
    await this.event(wf.id, 'skipped', 'You chose to continue without a tailored resume.', 'RESUME', { reason: steps.RESUME.data?.reason });
    await this.claimAndEnqueue(userId, wf.id, L.app.id, 'resumed');
    return this.get(userId, jobId);
  }

  // ─── Approval (the only path that can lead to an email being sent) ───────────

  /**
   * The user's explicit "approve". For an email, this approves the draft (the existing send safeguards then
   * apply: daily limits, spacing, cooldown, suppression list). For an external application it only records
   * the approval — nothing is submitted anywhere.
   */
  async approve(userId: string, jobId: string): Promise<PreparationView> {
    const L = await this.load(userId, jobId);
    const { wf, app } = L;
    if (!wf) throw new DomainError('Prepare the application before approving it.', 409);
    if (wf.status === 'COMPLETED') return this.get(userId, jobId); // double click
    if (wf.status !== 'READY_FOR_REVIEW') throw new DomainError(`Not ready to approve: preparation is "${WORKFLOW_STATUS_LABEL[wf.status as WorkflowStatus].toLowerCase()}".`, 409);
    if (!PREPARABLE.includes(app.status)) throw new DomainError('This application can no longer be approved.', 409);

    const steps = normalizeSteps(wf.steps);
    const outreachId = (steps.EMAIL.data as { outreachId?: string } | undefined)?.outreachId;
    if (wf.mode === 'EMAIL' && outreachId) await this.outreach.approve(userId, outreachId); // throws (and approves nothing) if it can't be sent
    await this.applications.approvePackage(app.id);
    await this.prisma.preparationWorkflow.update({ where: { id: wf.id }, data: { status: 'COMPLETED', finishedAt: new Date() } });
    await this.event(wf.id, 'approved', wf.mode === 'EMAIL' ? 'You approved the email. It will be sent by the background worker.' : 'You approved the application package.');
    await this.audit.log('preparation.approved', { userId, entityType: 'application', entityId: app.id, metadata: { workflowId: wf.id, mode: wf.mode } });
    return this.get(userId, jobId);
  }

  // ─── Lifecycle actions ─────────────────────────────────────────────────────

  async lifecycle(userId: string, applicationId: string, action: LifecycleAction) {
    const app = await this.applications.get(userId, applicationId);
    let updated;
    try {
      updated = await this.applications.lifecycleAction(userId, applicationId, action);
    } catch (e) {
      if (e instanceof InvalidTransitionError) {
        throw new DomainError(`You can't do that while the job is "${STAGE_LABEL[stageOf(app.status)].toLowerCase()}".`, 409);
      }
      throw e;
    }
    if (action === 'skip' || action === 'archive') {
      // A skipped job must not leave an unsent draft behind.
      const drafts = await this.prisma.outreach.findMany({ where: { applicationId, userId, kind: 'INITIAL', status: 'DRAFT' }, select: { id: true } });
      for (const d of drafts) await this.outreach.cancel(userId, d.id).catch((e: Error) => this.logger.warn({ msg: 'Could not cancel draft', outreachId: d.id, error: e.message }));
    }
    const wf = await this.prisma.preparationWorkflow.findUnique({ where: { applicationId } });
    const did = { shortlist: 'Job shortlisted.', skip: 'Job skipped.', restore: 'Job restored to Shortlisted.', archive: 'Job archived.', mark_applied: 'Job marked as applied by you.' }[action];
    if (wf) await this.event(wf.id, action, did);
    return { status: updated.status, lifecycle: lifecycleOf(updated.status, { workflow: wf ? { status: wf.status, mode: wf.mode } : null }) };
  }

  // ─── Execution (runs in the worker) ────────────────────────────────────────

  async execute(workflowId: string): Promise<{ status: WorkflowStatus; ran: StepKey[] } | { skipped: true }> {
    const release = await this.redis.acquireLock(`prepare:${workflowId}`, 15 * 60_000);
    if (!release) return { skipped: true };
    const ran: StepKey[] = [];
    try {
      const wf0 = await this.prisma.preparationWorkflow.findUnique({ where: { id: workflowId } });
      if (!wf0) return { skipped: true };
      const userId = wf0.userId;
      // A step left RUNNING means an earlier worker died mid-step (we hold the lock, so nobody is running it now).
      let steps = normalizeSteps(wf0.steps);
      for (const k of STEP_KEYS) if (steps[k].status === 'RUNNING') steps[k] = { ...steps[k], status: 'PENDING' };

      // Each step is attempted at most once per run, so a step that keeps failing cannot loop forever.
      const attempted = new Set<StepKey>();
      for (;;) {
        const L = await this.loadByApplication(userId, wf0.applicationId);
        if (ABANDONED.includes(L.app.status)) {
          await this.event(workflowId, 'cancelled', 'Preparation stopped because the job was skipped, archived, or already approved.');
          break;
        }
        const next = runnableSteps(steps).find((k) => !attempted.has(k));
        if (!next) break;
        attempted.add(next);
        steps = { ...steps, [next]: { ...steps[next], status: 'RUNNING', attempts: steps[next].attempts + 1, startedAt: new Date().toISOString(), finishedAt: undefined, error: undefined } };
        await this.saveSteps(workflowId, steps, 'IN_PROGRESS');
        await this.event(workflowId, 'started', `${STEP_LABEL[next]}…`, next);
        try {
          const res = await this.runStep(next, userId, L, steps);
          steps = { ...steps, [next]: { ...steps[next], status: res.status, finishedAt: new Date().toISOString(), summary: res.summary, data: res.data, needs: res.needs, error: undefined } };
          await this.event(workflowId, res.status === 'DONE' ? 'succeeded' : 'needs_input', res.summary, next);
        } catch (e) {
          const msg = clip(e instanceof Error ? e.message : String(e));
          steps = { ...steps, [next]: { ...steps[next], status: 'FAILED', finishedAt: new Date().toISOString(), error: msg, summary: undefined } };
          await this.event(workflowId, 'failed', msg, next);
          this.logger.warn({ msg: 'Preparation step failed', workflowId, step: next, error: msg });
        }
        ran.push(next);
        await this.saveSteps(workflowId, steps, 'IN_PROGRESS');
      }

      const status = deriveStatus(steps);
      const mode = (steps.EMAIL.data as { mode?: string } | undefined)?.mode === 'EMAIL' ? 'EMAIL' : steps.EMAIL.status === 'DONE' ? 'EXTERNAL' : null;
      await this.prisma.preparationWorkflow.update({ where: { id: workflowId }, data: { steps: steps as unknown as Json, status, mode, finishedAt: new Date(), heartbeatAt: new Date() } });
      await this.applications.moveForWorkflow(wf0.applicationId, status === 'READY_FOR_REVIEW' ? 'READY_FOR_REVIEW' : 'PREPARING');
      await this.event(workflowId, 'finished', `Preparation finished: ${WORKFLOW_STATUS_LABEL[status].toLowerCase()}.`);
      return { status, ran };
    } catch (e) {
      // Something outside any single step broke. Say so, and make the workflow retryable instead of leaving it "in progress".
      const msg = clip(e instanceof Error ? e.message : String(e));
      this.logger.error({ msg: 'Preparation run crashed', workflowId, error: msg });
      await this.prisma.preparationWorkflow.update({ where: { id: workflowId }, data: { status: 'FAILED', finishedAt: new Date() } }).catch(() => undefined);
      await this.event(workflowId, 'failed', `The preparation run stopped unexpectedly: ${msg}`).catch(() => undefined);
      return { status: 'FAILED', ran };
    } finally {
      await release();
    }
  }

  private async loadByApplication(userId: string, applicationId: string) {
    const app = await this.prisma.application.findFirstOrThrow({ where: { id: applicationId, userId }, select: { jobId: true } });
    return this.load(userId, app.jobId);
  }

  private async saveSteps(workflowId: string, steps: Steps, status: WorkflowStatus) {
    await this.prisma.preparationWorkflow.update({ where: { id: workflowId }, data: { steps: steps as unknown as Json, status, heartbeatAt: new Date() } });
  }

  private runStep(step: StepKey, userId: string, L: Awaited<ReturnType<PreparationService['load']>>, steps: Steps): Promise<Result> {
    switch (step) {
      case 'VALIDATE':
        return this.stepValidate(L);
      case 'COMPANY':
        return this.stepCompany(userId, L);
      case 'CONTACT':
        return this.stepContact(userId, L, steps);
      case 'RESUME':
        return this.stepResume(userId, L);
      case 'EMAIL':
        return this.stepEmail(userId, L, steps);
    }
  }

  // ─── Steps ─────────────────────────────────────────────────────────────────

  /** A. Is the job still open, can someone in India apply, and what do we not know? Never claims a check it could not do. */
  private async stepValidate(L: Awaited<ReturnType<PreparationService['load']>>): Promise<Result> {
    const { job } = L;
    const open = await this.verifyOpen(job);
    const summary = this.jobs.summary(job);
    const location = summary.facts.location.status;
    const missing = [
      ...(summary.facts.salary.known ? [] : ['salary']),
      ...(summary.facts.experience.known ? [] : ['required experience']),
      ...(summary.facts.companySize.known ? [] : ['company size']),
    ];
    const data = { open: open.state, note: open.note, checkedAt: open.checkedAt, via: open.via, location, locationLabel: summary.facts.location.label, missing };
    if (open.state === 'closed') {
      return {
        status: 'NEEDS_INPUT',
        summary: open.note,
        data,
        needs: { kind: 'confirm_open', message: `${open.note} Continue only if you know it is still open.` },
      };
    }
    const text = { listed: 'Still listed on the company board', reachable: "The posting page loads, but we can't confirm it still accepts applications", unverified: "Couldn't be checked automatically" }[open.state];
    return { status: 'DONE', summary: `${text}${open.state === 'listed' ? ' (checked just now)' : open.note ? ` — ${open.note}` : ''}. ${summary.facts.location.label}.`, data };
  }

  private async verifyOpen(job: { provider: string; externalId: string | null; url: string | null }): Promise<{ state: 'listed' | 'closed' | 'reachable' | 'unverified'; note: string; checkedAt: string; via: string }> {
    const checkedAt = new Date().toISOString();
    // Company boards list only open roles, so "not on the board any more" really means closed.
    const board = { GREENHOUSE: (t: string, id: string) => `https://boards.greenhouse.io/${t}/jobs/${id}`, ASHBY: (t: string, id: string) => `https://jobs.ashbyhq.com/${t}/${id}`, LEVER: (t: string, id: string) => `https://jobs.lever.co/${t}/${id}` }[job.provider as 'GREENHOUSE'];
    const [token, id] = job.externalId?.split(':') ?? [];
    if (board && token && id) {
      try {
        const found = await this.jobs.providerFor(job.provider as 'GREENHOUSE')?.getJob(board(token, id));
        return found
          ? { state: 'listed', note: '', checkedAt, via: `${job.provider.toLowerCase()}-api` }
          : { state: 'closed', note: 'This posting no longer appears on the company board.', checkedAt, via: `${job.provider.toLowerCase()}-api` };
      } catch (e) {
        return { state: 'unverified', note: `the board could not be reached (${clip((e as Error).message, 80)})`, checkedAt, via: `${job.provider.toLowerCase()}-api` };
      }
    }
    // Everything else has no lookup API. A page that loads proves little; a 404/410 proves the link is dead.
    if (!isPublicHttpUrl(job.url)) return { state: 'unverified', note: 'this posting has no public link to check', checkedAt, via: 'none' };
    try {
      if (!(await isAllowedByRobots(job.url))) return { state: 'unverified', note: "the site doesn't allow automated checks", checkedAt, via: 'robots' };
      const r = await httpFetch(job.url, { timeoutMs: 8000, maxBytes: 200_000 });
      if (r.status === 404 || r.status === 410) return { state: 'closed', note: 'The posting link no longer works (it returns "not found").', checkedAt, via: 'http' };
      if (r.status < 400) return { state: 'reachable', note: '', checkedAt, via: 'http' };
      return { state: 'unverified', note: `the site answered with HTTP ${r.status}`, checkedAt, via: 'http' };
    } catch (e) {
      return { state: 'unverified', note: clip((e as Error).message, 100), checkedAt, via: 'http' };
    }
  }

  /** B. Company facts, each with where it came from and when. Unknown stays unknown. */
  private async stepCompany(userId: string, L: Awaited<ReturnType<PreparationService['load']>>): Promise<Result> {
    const facts: CompanyFact[] = await this.companies.research(userId, L.job.companyId);
    const c = await this.prisma.company.findFirstOrThrow({ where: { id: L.job.companyId, userId } });
    const prov = (c.provenance as { source?: string; url?: string; fetchedAt?: string } | null) ?? null;
    const posting = `Job posting (${L.job.provider})`;
    const postedAsOf = L.job.createdAt.toISOString();
    const site = c.website ?? (c.domain ? `https://${c.domain}` : null);
    const salaryKnown = L.job.salaryMin != null || L.job.salaryMax != null;
    const view: CompanyFactView[] = [
      { label: 'Website', value: site, source: site ? posting : null, sourceUrl: L.job.url, asOf: site ? postedAsOf : null },
      {
        label: 'Size',
        value: c.teamSize ? `~${c.teamSize} people` : null,
        source: c.teamSize ? (prov?.source === 'yc-oss' ? 'YC startup directory' : (prov?.source ?? 'directory')) : null,
        sourceUrl: c.teamSize ? (prov?.url ?? null) : null,
        asOf: c.teamSize ? (prov?.fetchedAt ?? null) : null,
      },
      { label: 'Category', value: c.category, source: c.category ? (prov?.source === 'yc-oss' ? 'YC startup directory' : 'directory') : null, sourceUrl: c.category ? (prov?.url ?? null) : null, asOf: c.category ? (prov?.fetchedAt ?? null) : null },
      { label: 'Type', value: c.companyType ? c.companyType.replace(/_/g, ' ') : null, source: c.companyType ? 'Set by you' : null, sourceUrl: null, asOf: c.companyType ? c.updatedAt.toISOString() : null },
      {
        label: 'Compensation',
        value: salaryKnown ? 'Stated in the posting' : null,
        source: salaryKnown ? posting : null,
        sourceUrl: salaryKnown ? L.job.url : null,
        asOf: salaryKnown ? postedAsOf : null,
      },
      // No funding data source is configured; we say so instead of guessing.
      { label: 'Funding', value: null, source: null, sourceUrl: null, asOf: null },
      ...facts.slice(0, 2).map((f) => ({ label: 'About', value: f.text, source: 'Company website', sourceUrl: f.sourceUrl, asOf: f.fetchedAt })),
    ];
    const known = view.filter((f) => f.value).length;
    return { status: 'DONE', summary: `${known} of ${view.length} facts found. Funding is unknown (no funding source is configured).`, data: { facts: view } };
  }

  /** C. Public hiring contact only. Unverified addresses wait for the user's confirmation; nothing is guessed. */
  private async stepContact(userId: string, L: Awaited<ReturnType<PreparationService['load']>>, steps: Steps): Promise<Result> {
    await this.contacts.discover(userId, L.job.id);
    const app = await this.prisma.application.findUniqueOrThrow({ where: { id: L.app.id }, include: { contact: true } });
    const chosen = app.contact?.email && !app.contact.deletedAt ? app.contact : null;
    const confirmed = (steps.CONTACT.data as { confirmedContactId?: string } | undefined)?.confirmedContactId;

    if (chosen) {
      const trusted = chosen.confidence === 'VERIFIED' || chosen.source === 'manual' || confirmed === chosen.id;
      const how = chosen.source === 'manual' ? 'added by you' : confirmed === chosen.id ? 'confirmed by you' : `published via ${chosen.source}`;
      if (!trusted) {
        return {
          status: 'NEEDS_INPUT',
          summary: `Found ${chosen.email} (${chosen.confidence.toLowerCase()}) via ${chosen.source}, but it is not verified.`,
          data: { contactId: chosen.id, confirmedContactId: confirmed },
          needs: { kind: 'confirm_contact', contactId: chosen.id, message: `${chosen.name} <${chosen.email}> came from ${chosen.source} and is not verified. Use it anyway?` },
        };
      }
      return { status: 'DONE', summary: `${chosen.name} <${chosen.email}> — ${how}${chosen.sourceUrl ? ` (${chosen.sourceUrl})` : ''}.`, data: { contactId: chosen.id, confirmedContactId: confirmed } };
    }

    const q = (role: string) => `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${L.job.company.name} ${role}`)}`;
    const careers = L.job.company.careerUrl ?? L.job.company.website ?? (L.job.company.domain ? `https://${L.job.company.domain}` : null);
    const routes = [
      ...(L.job.url ? [{ label: 'Apply through the official posting', url: L.job.url }] : []),
      ...(careers ? [{ label: 'Company careers page', url: careers }] : []),
      { label: 'Find an engineering manager (LinkedIn search)', url: q('engineering manager') },
      { label: 'Find a technical recruiter (LinkedIn search)', url: q('technical recruiter') },
    ];
    return { status: 'DONE', summary: 'No public hiring contact was found. Emails are never guessed — use the official application link below.', data: { contactId: null, routes } };
  }

  /** D. Tailor (re-order only), compile, and check the PDF really opens. The master resume is never modified. */
  private async stepResume(userId: string, L: Awaited<ReturnType<PreparationService['load']>>): Promise<Result> {
    const { version, reused } = await this.resumes.tailor(userId, L.job.id, { useAi: this.ai.usesLlm });
    if (version.compileStatus === 'failed') throw new DomainError(`The tailored resume could not be built: ${(version.compileLog ?? '').split('\n')[0] || 'unknown error'}`, 422);
    const pdf = await this.resumes.renderPdf(userId, version.id);
    if (pdf.buffer.length < 1000 || pdf.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw new DomainError('The generated resume is not a valid PDF.', 422);
    const changes = (version.changes as unknown as { changes?: unknown[]; gaps?: string[]; pages?: number } | null) ?? {};
    const pages = changes.pages;
    return {
      status: 'DONE',
      summary: `${reused ? 'Reused your tailored resume (nothing changed since).' : 'Tailored your resume.'} PDF checked${pages ? ` (${pages} page${pages === 1 ? '' : 's'}, text selectable)` : ''}.`,
      data: { versionId: version.id, reused, aiAssisted: version.aiAssisted, pdfBytes: pdf.buffer.length, changes: Array.isArray(changes.changes) ? changes.changes.length : 0, gaps: changes.gaps ?? [] },
    };
  }

  /** E. A draft tied to the real job and a trusted recipient — or a checklist when there is no email to use. Never sends. */
  private async stepEmail(userId: string, L: Awaited<ReturnType<PreparationService['load']>>, steps: Steps): Promise<Result> {
    const contactId = (steps.CONTACT.data as { contactId?: string | null } | undefined)?.contactId;
    if (contactId) {
      try {
        // Returns the existing draft when there is one (no duplicate), and syncs it to the mailbox drafts.
        const noResume = !!(steps.RESUME.data as { skipped?: boolean } | undefined)?.skipped;
        let o = await this.outreach.generateInitial(userId, L.app.id, { contactId, attachResume: !noResume });
        if (noResume && o.attachResume) o = await this.outreach.updateDraft(userId, o.id, { attachResume: false }); // an earlier draft expected an attachment
        // The resume was tailored again after the draft was written: the draft must attach the current one.
        const current = await this.prisma.application.findUniqueOrThrow({ where: { id: L.app.id }, select: { resumeVersionId: true } });
        if (!noResume && o.status === 'DRAFT' && current.resumeVersionId && o.resumeVersionId !== current.resumeVersionId) {
          o = await this.prisma.outreach.update({ where: { id: o.id }, data: { resumeVersionId: current.resumeVersionId } });
          await this.outreach.syncDraft(o.id);
        }
        return { status: 'DONE', summary: `Draft ready for ${o.toEmail}${noResume ? ' (no resume attached)' : ''}. It has NOT been sent.`, data: { mode: 'EMAIL', outreachId: o.id } };
      } catch (e) {
        if (e instanceof DomainError && e.status === 409) {
          const existing = await this.prisma.outreach.findFirst({ where: { applicationId: L.app.id, kind: 'INITIAL', sequence: 0 }, orderBy: { createdAt: 'desc' } });
          return { status: 'DONE', summary: `An email to this contact already exists (${existing?.status.toLowerCase() ?? 'in progress'}).`, data: { mode: 'EMAIL', outreachId: existing?.id } };
        }
        throw e;
      }
    }
    const summary = this.jobs.summary(L.job);
    const checklist = [
      L.job.url ? `Open the official posting and apply there: ${L.job.url}` : 'Find the official application link on the company website.',
      (steps.RESUME.data as { skipped?: boolean } | undefined)?.skipped ? 'Use your own resume — a tailored one could not be built on this machine.' : 'Download your tailored resume (PDF) from this page and attach it.',
      ...(summary.whyMatches.length ? [`Points to mention: ${summary.whyMatches.slice(0, 2).join(' ')}`] : []),
      ...summary.toVerify.slice(0, 3).map((t) => `Check: ${t}`),
      'When you have applied, click "I applied" so the job is tracked.',
    ];
    return { status: 'DONE', summary: 'No contact email to use, so here is an application checklist instead.', data: { mode: 'CHECKLIST', checklist } };
  }
}
