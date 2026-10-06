import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Outreach, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuditService } from '../../common/audit.service';
import { DomainError } from '../../common/http';
import { MetricsService } from '../../common/metrics.service';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import { emailDomain, normalizeEmail } from '../../domain/dedupe';
import { buildMessageId, quotePrevious } from '../../domain/email/mime';
import { checkVoice, generateEmailInputSchema, GenerateEmailInput, VoiceRules } from '../../domain/email/voice';
import { decideFollowup } from '../../domain/followups/schedule';
import { MatchResult } from '../../domain/matching/scorer';
import { evaluateGuardrails, GuardrailResult, isSuppressed, startOfLocalDay } from '../../domain/outreach/guardrails';
import { extractJob, JobExtraction } from '../../domain/skills/extract';
import { EmailDraft } from '../../providers/ai/ai-provider.interface';
import { EmailProviderError, OutgoingEmail } from '../../providers/email/email-provider.interface';
import type { EmailAccount } from '@prisma/client';
import { AiService } from '../ai/ai.service';
import { ApplicationsService } from '../applications/applications.service';
import { CompaniesService, CompanyFact } from '../companies/companies.service';
import { EmailAccountsService } from '../email/email-accounts.service';
import { EmailSyncService } from '../email/email-sync.service';
import { FollowupsService } from '../followups/followups.service';
import { ProfileService } from '../profile/profile.service';
import { QueueService } from '../queues/queues';
import { ResumeService } from '../resume/resume.service';
import { SettingsService } from '../settings/settings.service';

/** Thrown by the send path when a send must simply happen later (limits / spacing / not due). */
export class RetryLaterError extends Error {
  constructor(
    message: string,
    public readonly delayMs: number,
  ) {
    super(message);
  }
}

export interface GenerateOptions {
  contactId?: string;
  style?: 'concise' | 'technical' | 'warm';
  attachResume?: boolean;
  regenerate?: boolean;
}

const INITIAL_RULES = { minWords: 60, maxWords: 150 };
const FOLLOWUP_RULES = { minWords: 12, maxWords: 100 };

@Injectable()
export class OutreachService {
  private readonly logger = new Logger(OutreachService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly ai: AiService,
    private readonly profiles: ProfileService,
    private readonly settings: SettingsService,
    private readonly companies: CompaniesService,
    private readonly resumes: ResumeService,
    private readonly accounts: EmailAccountsService,
    private readonly followups: FollowupsService,
    private readonly sync: EmailSyncService,
    private readonly applications: ApplicationsService,
    private readonly queues: QueueService,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
  ) {}

  private async voiceRules(jobSkills: string[], base: { minWords: number; maxWords: number }): Promise<VoiceRules> {
    const profile = await this.profiles.get();
    const implied = ['SQL', 'Caching', 'Queue Systems', 'JavaScript', 'Observability'];
    return { ...base, candidateSkills: [...profile.strongSkills, ...profile.domainSkills, ...implied], jobSkills };
  }

  // ─── Initial email ─────────────────────────────────────────────────────────

  async generateInitial(userId: string, applicationId: string, opts: GenerateOptions = {}) {
    const app = await this.prisma.application.findFirst({
      where: { id: applicationId, userId, deletedAt: null },
      include: { job: { include: { company: true } }, contact: true },
    });
    if (!app) throw new NotFoundException('Application not found');
    const contactId = opts.contactId ?? app.contactId;
    if (!contactId) throw new DomainError('Pick a contact before generating the email.', 400);
    const contact = await this.prisma.contact.findFirst({ where: { id: contactId, userId, deletedAt: null } });
    if (!contact) throw new NotFoundException('Contact not found');
    if (!contact.email) throw new DomainError('This contact has no email address. Add one or pick another contact.', 400);
    if (contact.companyId !== app.job.companyId) throw new DomainError('Contact belongs to a different company', 400);

    const existing = await this.prisma.outreach.findUnique({ where: { applicationId_contactId_sequence: { applicationId, contactId, sequence: 0 } } });
    if (existing && !['DRAFT', 'FAILED', 'CANCELLED'].includes(existing.status)) {
      throw new DomainError(`An email to this contact is already ${existing.status.toLowerCase()} — it can't be regenerated.`, 409);
    }
    if (existing && existing.status === 'DRAFT' && !opts.regenerate) return existing;

    const settings = await this.settings.get(userId);
    const profile = await this.profiles.get();
    const style = opts.style ?? (existing?.style as GenerateOptions['style']) ?? settings.outreach.defaultStyle;
    const attachResume = opts.attachResume ?? existing?.attachResume ?? true;
    const job = app.job;
    const extraction = (job.extracted as unknown as JobExtraction | null) ?? extractJob({ title: job.title, description: job.description, location: job.location, companyName: job.company.name });
    const match = job.scoreBreakdown as unknown as MatchResult | null;
    const facts = ((job.company.research as unknown as CompanyFact[] | null) ?? []).slice(0, 3);
    const jobSkills = [...extraction.requiredSkills, ...extraction.preferredSkills];
    const regenCount = existing ? (existing.warnings as unknown as { regen?: number })?.regen ?? 0 : 0;

    const input: GenerateEmailInput = generateEmailInputSchema.parse({
      jobTitle: job.title,
      companyName: job.company.name,
      recipientName: contact.name,
      recipientRole: contact.role,
      recipientCategory: contact.roleCategory,
      jobSkills,
      overlapSkills: match?.strong ?? jobSkills.filter((s) => profile.strongSkills.includes(s)),
      missingSkills: [...(match?.skills.filter((s) => s.required && s.level !== 'strong').map((s) => s.skill) ?? []), ...(match?.skills.filter((s) => !s.required && s.level === 'partial').map((s) => s.skill) ?? [])],
      companyFacts: facts.map((f) => ({ text: f.text, sourceUrl: f.sourceUrl })),
      jobSummary: job.description.slice(0, 8000),
      style,
      attachResume,
      workMode: extraction.workMode,
      variantSeed: `${job.id}:${contact.id}:${regenCount + (opts.regenerate ? 1 : 0)}`,
    });

    const { draft, warnings, aiGenerated } = await this.draftWithChecks(userId, 'EMAIL', input, jobSkills, INITIAL_RULES, (problems) => (p) => p.generateEmail({ profile, input, previousProblems: problems }), !!opts.regenerate);

    const id = existing?.id ?? randomUUID();
    const account = await this.accounts.sendingAccount(userId).catch(() => null);
    const data = {
      subject: draft.subject.trim(),
      body: draft.body.trim(),
      style,
      attachResume,
      toEmail: contact.email,
      status: 'DRAFT' as const,
      error: null,
      aiGenerated,
      resumeVersionId: app.resumeVersionId,
      emailAccountId: account?.id ?? null,
      warnings: { items: warnings, regen: regenCount + (opts.regenerate ? 1 : 0), provider: draft.provider } as unknown as Prisma.InputJsonValue,
    };
    const outreach = existing
      ? await this.prisma.outreach.update({ where: { id }, data })
      : await this.prisma.outreach.create({
          data: { ...data, id, userId, applicationId, contactId, kind: 'INITIAL', sequence: 0, messageIdHeader: buildMessageId(id, account ? emailDomain(account.email) : '') },
        });
    if (app.contactId !== contactId) await this.prisma.application.update({ where: { id: applicationId }, data: { contactId } });
    await this.applications.autoAdvance(applicationId, 'EMAIL_READY');
    await this.audit.log('outreach.draft_generated', { userId, entityType: 'outreach', entityId: outreach.id, metadata: { provider: draft.provider, style } });
    await this.syncDraft(outreach.id);
    return this.prisma.outreach.findUniqueOrThrow({ where: { id: outreach.id } });
  }

  /**
   * Generate with the configured provider, validate against the voice/truth rules,
   * retry once with feedback, then fall back to the deterministic template.
   */
  private async draftWithChecks(
    userId: string,
    kind: 'EMAIL' | 'FOLLOWUP',
    cacheInput: unknown,
    jobSkills: string[],
    limits: { minWords: number; maxWords: number },
    makeCall: (problems?: string[]) => Parameters<AiService['run']>[3],
    force: boolean,
  ): Promise<{ draft: EmailDraft; warnings: string[]; aiGenerated: boolean }> {
    const rules = await this.voiceRules(jobSkills, limits);
    let problems: string[] | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.ai.run<EmailDraft>(userId, kind, { cacheInput, problems, attempt }, makeCall(problems) as never, { force: force || attempt > 0 });
      const check = checkVoice(r.output, rules);
      if (check.ok) return { draft: { ...r.output, provider: r.provider }, warnings: check.warnings, aiGenerated: r.provider !== 'template' };
      problems = check.problems;
      this.logger.warn({ msg: 'Draft failed voice check', kind, attempt, problems });
      if (r.provider === 'template') break;
    }
    // Deterministic fallback — always truthful.
    const fb = await makeCall(undefined)(this.ai.template);
    const check = checkVoice(fb.output as EmailDraft, rules);
    return {
      draft: { ...(fb.output as EmailDraft), provider: 'template' },
      warnings: [...check.warnings, ...check.problems.map((p) => `Review: ${p}`), ...(problems ? [`AI draft rejected: ${problems.join('; ')}`] : [])],
      aiGenerated: false,
    };
  }

  async updateDraft(userId: string, id: string, patch: { subject?: string; body?: string; toEmail?: string; attachResume?: boolean }) {
    const o = await this.getOwned(userId, id);
    if (!['DRAFT', 'APPROVED', 'FAILED'].includes(o.status)) throw new DomainError(`Cannot edit an email that is ${o.status.toLowerCase()}`, 409);
    if (patch.toEmail && o.kind === 'FOLLOWUP') throw new DomainError('Follow-ups go to the original recipient', 400);
    const job = await this.prisma.job.findFirstOrThrow({ where: { application: { id: o.applicationId } }, include: { company: true } });
    const ex = (job.extracted as unknown as JobExtraction | null) ?? extractJob({ title: job.title, description: job.description, companyName: job.company.name });
    const subject = patch.subject ?? o.subject;
    const body = patch.body ?? o.body;
    const check = checkVoice({ subject: o.kind === 'FOLLOWUP' ? subject || 'Re' : subject, body }, await this.voiceRules([...ex.requiredSkills, ...ex.preferredSkills], o.kind === 'INITIAL' ? INITIAL_RULES : FOLLOWUP_RULES));
    const prevWarnings = (o.warnings as unknown as Record<string, unknown>) ?? {};
    const updated = await this.prisma.outreach.update({
      where: { id },
      data: {
        subject,
        body,
        ...(patch.toEmail ? { toEmail: patch.toEmail.trim() } : {}),
        ...(patch.attachResume !== undefined ? { attachResume: patch.attachResume } : {}),
        // Any edit requires re-approval.
        status: 'DRAFT',
        approvedAt: null,
        warnings: { ...prevWarnings, items: [...check.warnings, ...check.problems.map((p) => `Review: ${p}`)], edited: true } as unknown as Prisma.InputJsonValue,
      },
    });
    await this.queues.cancelSend(id);
    if (o.kind === 'FOLLOWUP') await this.prisma.followup.updateMany({ where: { outreachId: id, status: 'APPROVED' }, data: { status: 'DRAFT_READY' } });
    await this.syncDraft(id);
    return this.prisma.outreach.findUniqueOrThrow({ where: { id: updated.id } });
  }

  /** Evaluate guardrails for an outreach row as of now (used by approve + send). */
  async evaluate(o: Outreach, now = new Date()): Promise<GuardrailResult> {
    const settings = await this.settings.get(o.userId);
    const dayStart = startOfLocalDay(now, settings.timezone);
    const app = await this.prisma.application.findUniqueOrThrow({ where: { id: o.applicationId }, include: { job: true } });
    const to = normalizeEmail(o.toEmail);
    const [sentToday, initialSentToday, last, toRecipient, toCompany, suppressions] = await Promise.all([
      this.prisma.outreach.count({ where: { userId: o.userId, status: 'SENT', sentAt: { gte: dayStart } } }),
      this.prisma.outreach.count({ where: { userId: o.userId, status: 'SENT', kind: 'INITIAL', sentAt: { gte: dayStart } } }),
      this.prisma.outreach.findFirst({ where: { userId: o.userId, status: 'SENT' }, orderBy: { sentAt: 'desc' }, select: { sentAt: true } }),
      this.prisma.outreach.findMany({ where: { userId: o.userId, kind: 'INITIAL', status: 'SENT', toEmail: { equals: to, mode: 'insensitive' }, id: { not: o.id } }, select: { sentAt: true, applicationId: true } }),
      this.prisma.outreach.findMany({
        where: { userId: o.userId, kind: 'INITIAL', status: 'SENT', id: { not: o.id }, application: { job: { companyId: app.job.companyId } } },
        select: { sentAt: true, applicationId: true, toEmail: true },
        orderBy: { sentAt: 'desc' },
      }),
      this.prisma.suppression.findMany({ where: { userId: o.userId }, select: { value: true } }),
    ]);
    return evaluateGuardrails(
      {
        kind: o.kind,
        toEmail: o.toEmail,
        companyId: app.job.companyId,
        now,
        sentToday,
        initialSentToday,
        lastSentAt: last?.sentAt ?? null,
        previousToRecipient: toRecipient.map((r) => ({ sentAt: r.sentAt!, applicationId: r.applicationId })),
        previousToCompany: toCompany.map((r) => ({ sentAt: r.sentAt!, applicationId: r.applicationId, toEmail: r.toEmail })),
        applicationId: o.applicationId,
        suppressions: suppressions.map((s) => s.value),
        approved: o.status === 'APPROVED' || o.status === 'SENDING',
        overrideCompanyCooldown: o.overrideCooldown,
      },
      settings,
    );
  }

  /** Explicit user approval. Queues the send; limits/spacing are enforced by the worker. */
  async approve(userId: string, id: string, opts: { overrideCompanyCooldown?: boolean } = {}) {
    const o = await this.getOwned(userId, id);
    if (!['DRAFT', 'FAILED', 'APPROVED'].includes(o.status)) throw new DomainError(`Cannot approve an email that is ${o.status.toLowerCase()}`, 409);
    const preview = await this.evaluate({ ...o, status: 'APPROVED', overrideCooldown: opts.overrideCompanyCooldown ?? o.overrideCooldown });
    const hard = preview.blockers.filter((b) => !/^(Daily|Spacing)/.test(b));
    if (hard.length) throw new DomainError('This email cannot be sent', 422, { blockers: hard, warnings: preview.warnings });
    await this.accounts.sendingAccount(userId); // fails early if Gmail isn't connected
    if (o.kind === 'INITIAL' && o.attachResume) await this.resumes.renderPdf(userId, o.resumeVersionId); // fails early if the PDF can't be built
    const updated = await this.prisma.outreach.update({
      where: { id },
      data: { status: 'APPROVED', approvedAt: new Date(), error: null, overrideCooldown: opts.overrideCompanyCooldown ?? o.overrideCooldown },
    });
    let delayMs = 0;
    if (o.kind === 'FOLLOWUP') {
      const f = await this.prisma.followup.findUnique({ where: { outreachId: id } });
      if (f) {
        await this.prisma.followup.update({ where: { id: f.id }, data: { status: 'APPROVED' } });
        delayMs = Math.max(0, f.scheduledAt.getTime() - Date.now());
      }
    }
    await this.queues.send({ userId, outreachId: id }, delayMs);
    await this.audit.log('outreach.approved', { userId, entityType: 'outreach', entityId: id, metadata: { kind: o.kind, overrideCompanyCooldown: !!opts.overrideCompanyCooldown } });
    return { outreach: updated, guardrails: preview, scheduledInMs: delayMs };
  }

  async cancel(userId: string, id: string) {
    const o = await this.getOwned(userId, id);
    if (!['DRAFT', 'APPROVED', 'FAILED'].includes(o.status)) throw new DomainError(`Cannot cancel an email that is ${o.status.toLowerCase()}`, 409);
    await this.queues.cancelSend(id);
    await this.deleteDraft(o);
    return this.prisma.outreach.update({ where: { id }, data: { status: 'CANCELLED', gmailDraftId: null } });
  }

  // ─── Sending (worker) ──────────────────────────────────────────────────────

  /**
   * Idempotent send. Safe under worker retries:
   *  1. only APPROVED/SENDING rows are sendable (conditional update = DB-level claim)
   *  2. on a retry, ask the mailbox whether our Message-ID was already sent
   *  3. follow-ups re-check for replies against the live mailbox right before sending
   */
  async sendNow(outreachId: string): Promise<{ status: string; reason?: string }> {
    const release = await this.redis.acquireLock(`send:${outreachId}`, 120_000);
    if (!release) throw new RetryLaterError('Another worker is sending this email', 15_000);
    try {
      const o = await this.prisma.outreach.findUnique({ where: { id: outreachId } });
      if (!o) return { status: 'missing' };
      if (o.status === 'SENT') return { status: 'already_sent' };
      if (!['APPROVED', 'SENDING'].includes(o.status)) return { status: 'skipped', reason: `status ${o.status}` };

      if (o.kind === 'FOLLOWUP') {
        const gate = await this.followupGate(o);
        if (gate) return gate;
      }

      const guard = await this.evaluate(o);
      if (!guard.allowed) {
        if (guard.retryAt) throw new RetryLaterError(guard.blockers.join(' '), Math.max(5_000, guard.retryAt.getTime() - Date.now()));
        await this.markFailed(o, guard.blockers.join(' '));
        return { status: 'blocked', reason: guard.blockers.join(' ') };
      }

      // Claim the row. If another process changed it, stop.
      const claimed = await this.prisma.outreach.updateMany({ where: { id: o.id, status: { in: ['APPROVED', 'SENDING'] } }, data: { status: 'SENDING', sendAttempts: { increment: 1 } } });
      if (claimed.count === 0) return { status: 'skipped', reason: 'state changed' };

      const account = o.emailAccountId
        ? await this.prisma.emailAccount.findUniqueOrThrow({ where: { id: o.emailAccountId } })
        : await this.accounts.sendingAccount(o.userId);
      const provider = this.accounts.providerFor(account);
      const mailbox = this.accounts.mailbox(account);

      // Already sent — from Gmail by the user, or by a previous attempt that crashed before recording it.
      if (o.draftMessageId) {
        const state = await provider.getMessageState(mailbox, o.draftMessageId);
        if (state?.labelIds.includes('SENT')) {
          await this.markSent(o, account.id, o.draftMessageId, state.threadId);
          return { status: 'sent', reason: 'draft was already sent' };
        }
      }
      if (o.sendAttempts > 0) {
        const already = await provider.findByMessageIdHeader(mailbox, o.messageIdHeader);
        if (already) {
          await this.markSent(o, account.id, already.messageId, already.threadId);
          return { status: 'sent', reason: 'recovered previous send' };
        }
      }

      let outgoing: OutgoingEmail;
      try {
        outgoing = await this.buildOutgoing(o, account);
      } catch (e) {
        await this.markFailed(o, (e as Error).message);
        return { status: 'failed', reason: (e as Error).message };
      }

      try {
        let sent;
        if (o.gmailDraftId) {
          // Send the Gmail draft, making sure it holds exactly the approved content first.
          const ref = await provider.upsertDraft(mailbox, outgoing, o.gmailDraftId);
          await this.prisma.outreach.update({ where: { id: o.id }, data: { gmailDraftId: ref.draftId, draftMessageId: ref.messageId } });
          o.draftMessageId = ref.messageId;
          sent = await provider.sendDraft(mailbox, ref.draftId);
        } else {
          sent = await provider.send(mailbox, outgoing);
        }
        await this.markSent(o, account.id, sent.messageId, sent.threadId);
        return { status: 'sent' };
      } catch (e) {
        const err = e as Error;
        await this.metrics.record(o.kind === 'FOLLOWUP' ? 'followup.failure' : 'email.failure', { outreachId: o.id, error: err.message });
        if (e instanceof EmailProviderError && !e.retryable) {
          await this.markFailed(o, err.message);
          return { status: 'failed', reason: err.message };
        }
        await this.prisma.outreach.update({ where: { id: o.id }, data: { error: err.message.slice(0, 500) } });
        throw e; // retryable: BullMQ retries; the Message-ID check prevents duplicates
      }
    } finally {
      await release();
    }
  }

  /** Build the exact message (headers, threading, quoted history, tailored PDF). */
  private async buildOutgoing(o: Outreach, account: EmailAccount): Promise<OutgoingEmail> {
    const root = o.rootId ? await this.prisma.outreach.findUniqueOrThrow({ where: { id: o.rootId } }) : null;
    const prior = root
      ? await this.prisma.outreach.findMany({ where: { rootId: root.id, status: 'SENT', sequence: { lt: o.sequence } }, orderBy: { sequence: 'asc' }, select: { messageIdHeader: true } })
      : [];
    const profile = await this.profiles.get();
    const attachments = [];
    if (o.attachResume && o.kind === 'INITIAL') {
      const pdf = await this.resumes.renderPdf(o.userId, o.resumeVersionId);
      attachments.push({ filename: pdf.filename, contentType: 'application/pdf', content: pdf.buffer });
    }
    const contact = await this.prisma.contact.findUnique({ where: { id: o.contactId }, select: { name: true } });
    return {
      fromName: profile.name,
      to: o.toEmail,
      toName: contact && !/team/i.test(contact.name) ? contact.name : undefined,
      subject: root ? (root.subject.startsWith('Re:') ? root.subject : `Re: ${root.subject}`) : o.subject,
      text: root ? quotePrevious(o.body, root.body, root.sentAt ?? new Date(), `${profile.name} <${account.email}>`) : o.body,
      messageIdHeader: o.messageIdHeader,
      threadId: root?.gmailThreadId ?? null,
      inReplyTo: root?.messageIdHeader ?? null,
      references: root ? [root.messageIdHeader, ...prior.map((p) => p.messageIdHeader)] : undefined,
      attachments,
    };
  }

  /**
   * Mirror an unsent email into the mailbox's Drafts (Gmail), with the tailored
   * resume attached. Failures are recorded on the row and never block the app.
   */
  async syncDraft(outreachId: string): Promise<void> {
    const o = await this.prisma.outreach.findUnique({ where: { id: outreachId } });
    if (!o || !['DRAFT', 'APPROVED'].includes(o.status)) return;
    const settings = await this.settings.get(o.userId);
    if (!settings.automation.createGmailDrafts) return;
    try {
      const account = o.emailAccountId ? await this.prisma.emailAccount.findUniqueOrThrow({ where: { id: o.emailAccountId } }) : await this.accounts.sendingAccount(o.userId);
      if (account.status !== 'CONNECTED') throw new Error('Mailbox is not connected');
      const outgoing = await this.buildOutgoing(o, account);
      const ref = await this.accounts.providerFor(account).upsertDraft(this.accounts.mailbox(account), outgoing, o.gmailDraftId);
      await this.prisma.outreach.update({ where: { id: o.id }, data: { gmailDraftId: ref.draftId, draftMessageId: ref.messageId, draftSyncedAt: new Date(), draftSyncError: null, emailAccountId: account.id } });
      if (!o.gmailDraftId) {
        await this.prisma.emailEvent.create({ data: { userId: o.userId, outreachId: o.id, emailAccountId: account.id, type: 'DRAFT_CREATED', metadata: { draftId: ref.draftId } } });
      }
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      await this.prisma.outreach.update({ where: { id: o.id }, data: { draftSyncError: msg } });
      this.logger.warn({ msg: 'Draft sync failed', outreachId, error: msg });
    }
  }

  /** Re-sync all unsent drafts of an application (e.g. after the resume was re-tailored). */
  async resyncApplicationDrafts(applicationId: string): Promise<void> {
    const rows = await this.prisma.outreach.findMany({ where: { applicationId, status: { in: ['DRAFT', 'APPROVED'] } }, select: { id: true, resumeVersionId: true } });
    const app = await this.prisma.application.findUnique({ where: { id: applicationId }, select: { resumeVersionId: true } });
    for (const r of rows) {
      if (app?.resumeVersionId && r.resumeVersionId !== app.resumeVersionId) await this.prisma.outreach.update({ where: { id: r.id }, data: { resumeVersionId: app.resumeVersionId } });
      await this.syncDraft(r.id);
    }
  }

  private async deleteDraft(o: Outreach): Promise<void> {
    if (!o.gmailDraftId || !o.emailAccountId) return;
    try {
      const account = await this.prisma.emailAccount.findUniqueOrThrow({ where: { id: o.emailAccountId } });
      await this.accounts.providerFor(account).deleteDraft(this.accounts.mailbox(account), o.gmailDraftId);
    } catch (e) {
      this.logger.warn({ msg: 'Could not delete draft', outreachId: o.id, error: (e as Error).message });
    }
  }

  /**
   * Detect drafts the user sent (or deleted) directly in Gmail. Sending from Gmail
   * is an explicit user action, so it counts as approval: we record it and start tracking.
   */
  async reconcileDrafts(userId: string): Promise<{ sentFromMailbox: number; deleted: number }> {
    const rows = await this.prisma.outreach.findMany({ where: { userId, status: { in: ['DRAFT', 'APPROVED'] }, draftMessageId: { not: null }, emailAccountId: { not: null } } });
    let sentFromMailbox = 0;
    let deleted = 0;
    for (const o of rows) {
      try {
        const account = await this.prisma.emailAccount.findUniqueOrThrow({ where: { id: o.emailAccountId! } });
        if (account.status !== 'CONNECTED') continue;
        const state = await this.accounts.providerFor(account).getMessageState(this.accounts.mailbox(account), o.draftMessageId!);
        if (state?.labelIds.includes('SENT')) {
          await this.prisma.outreach.update({ where: { id: o.id }, data: { approvedAt: o.approvedAt ?? new Date() } });
          await this.queues.cancelSend(o.id);
          await this.markSent(o, account.id, o.draftMessageId!, state.threadId);
          sentFromMailbox++;
        } else if (!state) {
          await this.prisma.outreach.update({ where: { id: o.id }, data: { gmailDraftId: null, draftMessageId: null, draftSyncError: 'Draft was deleted in Gmail — it will be re-created when you edit or approve it.' } });
          deleted++;
        }
      } catch (e) {
        this.logger.warn({ msg: 'Draft reconcile failed', outreachId: o.id, error: (e as Error).message });
      }
    }
    return { sentFromMailbox, deleted };
  }

  /** The reply gate for follow-ups. Returns a terminal result, or null to proceed. */
  private async followupGate(o: Outreach): Promise<{ status: string; reason?: string } | null> {
    const f = await this.prisma.followup.findUnique({ where: { outreachId: o.id } });
    if (!f || !o.rootId) {
      await this.markFailed(o, 'Follow-up record missing');
      return { status: 'failed', reason: 'Follow-up record missing' };
    }
    // Live mailbox check right before sending.
    let replyDetected = false;
    try {
      replyDetected = (await this.sync.syncRootById(o.rootId)).replied;
    } catch (e) {
      // If we cannot verify there was no reply, we do not send.
      throw new RetryLaterError(`Could not check for replies: ${(e as Error).message}`, 10 * 60_000);
    }
    const root = await this.prisma.outreach.findUniqueOrThrow({ where: { id: o.rootId } });
    const prev = f.sequence > 1 ? await this.prisma.followup.findUnique({ where: { rootId_sequence: { rootId: o.rootId, sequence: f.sequence - 1 } } }) : null;
    const suppressions = await this.prisma.suppression.findMany({ where: { userId: o.userId }, select: { value: true } });
    const decision = decideFollowup({
      threadState: root.threadState,
      followupStatus: f.status === 'APPROVED' ? 'APPROVED' : f.status,
      scheduledAt: f.scheduledAt,
      now: new Date(),
      replyDetected,
      suppressed: isSuppressed(o.toEmail, suppressions.map((s) => s.value)),
      previousSequenceSent: f.sequence === 1 ? root.status === 'SENT' : !!prev && ['SENT', 'SKIPPED'].includes(prev.status),
    });
    if (decision.action === 'cancel') {
      await this.followups.cancelForRoot(o.rootId, decision.reason);
      await this.prisma.outreach.updateMany({ where: { id: o.id, status: { in: ['APPROVED', 'SENDING'] } }, data: { status: 'CANCELLED', error: decision.reason } });
      return { status: 'cancelled', reason: decision.reason };
    }
    if (decision.action === 'wait') {
      const delay = decision.reason === 'Not due yet' ? f.scheduledAt.getTime() - Date.now() : 60 * 60_000;
      throw new RetryLaterError(decision.reason, Math.max(5_000, delay));
    }
    return null;
  }

  private async markSent(o: Outreach, accountId: string, messageId: string, threadId: string): Promise<void> {
    const sentAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.outreach.update({
        where: { id: o.id },
        data: {
          status: 'SENT',
          sentAt,
          gmailMessageId: messageId,
          gmailThreadId: threadId,
          emailAccountId: accountId,
          gmailDraftId: null,
          error: null,
          ...(o.kind === 'INITIAL' ? { threadState: 'WAITING_FOR_REPLY' as const } : {}),
        },
      });
      await tx.emailEvent.create({ data: { userId: o.userId, outreachId: o.id, emailAccountId: accountId, type: 'SENT', providerMessageId: messageId, threadId, occurredAt: sentAt } });
      if (o.kind === 'INITIAL') {
        await this.applications.systemTransition(o.applicationId, 'EMAIL_SENT', tx);
        const scheduled = await this.followups.scheduleForRoot(updated, tx);
        await this.applications.systemTransition(o.applicationId, scheduled > 0 ? 'FOLLOWUP_SCHEDULED' : 'WAITING_FOR_REPLY', tx);
      } else {
        await tx.followup.updateMany({ where: { outreachId: o.id }, data: { status: 'SENT' } });
        const remaining = await tx.followup.count({ where: { rootId: o.rootId!, status: { in: ['SCHEDULED', 'DRAFT_READY', 'APPROVED'] } } });
        if (!remaining) await this.applications.systemTransition(o.applicationId, 'WAITING_FOR_REPLY', tx);
      }
    });
    if (o.kind === 'FOLLOWUP' && o.rootId) await this.followups.rescheduleNext(o.rootId, o.sequence, sentAt);
    await this.metrics.record(o.kind === 'FOLLOWUP' ? 'followup.sent' : 'email.sent', { outreachId: o.id });
    await this.audit.log('outreach.sent', { userId: o.userId, entityType: 'outreach', entityId: o.id, metadata: { kind: o.kind, sequence: o.sequence } });
  }

  private async markFailed(o: Outreach, reason: string): Promise<void> {
    await this.prisma.outreach.update({ where: { id: o.id }, data: { status: 'FAILED', error: reason.slice(0, 500) } });
    await this.prisma.emailEvent.create({ data: { userId: o.userId, outreachId: o.id, type: 'SEND_FAILED', metadata: { reason: reason.slice(0, 500) } } });
    if (o.kind === 'FOLLOWUP') await this.prisma.followup.updateMany({ where: { outreachId: o.id }, data: { status: 'FAILED' } });
  }

  // ─── Follow-up drafts ──────────────────────────────────────────────────────

  /** Create (or return) the draft email for a follow-up. */
  async generateFollowupDraft(followupId: string, opts: { regenerate?: boolean } = {}) {
    const f = await this.prisma.followup.findUniqueOrThrow({ where: { id: followupId }, include: { root: { include: { application: { include: { job: { include: { company: true } } } }, contact: true } } } });
    if (!['SCHEDULED', 'DRAFT_READY', 'FAILED'].includes(f.status)) throw new DomainError(`Follow-up is ${f.status.toLowerCase()}`, 409);
    if (f.root.threadState !== 'WAITING_FOR_REPLY') throw new DomainError('The thread is no longer waiting for a reply', 409);
    if (f.outreachId && !opts.regenerate) {
      const existing = await this.prisma.outreach.findUniqueOrThrow({ where: { id: f.outreachId } });
      if (existing.status !== 'CANCELLED') return existing;
    }
    const profile = await this.profiles.get();
    const settings = await this.settings.get(f.userId);
    const job = f.root.application.job;
    const ex = (job.extracted as unknown as JobExtraction | null) ?? extractJob({ title: job.title, description: job.description, companyName: job.company.name });
    const jobSkills = [...ex.requiredSkills, ...ex.preferredSkills];
    const previous = await this.prisma.outreach.findMany({ where: { OR: [{ id: f.rootId }, { rootId: f.rootId }], status: 'SENT' }, orderBy: { sequence: 'asc' } });
    const usedFacts = previous.flatMap((p) => ((p.warnings as unknown as { usedFact?: string })?.usedFact ? [(p.warnings as unknown as { usedFact: string }).usedFact] : []));
    const input = {
      profile,
      sequence: f.sequence,
      totalFollowups: settings.followups.delaysDays.length,
      recipientName: f.root.contact.name,
      jobTitle: job.title,
      companyName: job.company.name,
      jobSkills,
      previousEmails: previous.map((p) => ({ subject: p.subject, body: p.body, sentAt: (p.sentAt ?? p.createdAt).toISOString() })),
      usedFacts,
    };
    const { draft, warnings, aiGenerated } = await this.draftWithChecks(
      f.userId,
      'FOLLOWUP',
      { rootId: f.rootId, sequence: f.sequence, profile: profile.hash, previous: previous.map((p) => p.id) },
      jobSkills,
      FOLLOWUP_RULES,
      (problems) => (p) => p.generateFollowup({ ...input, previousProblems: problems }),
      !!opts.regenerate,
    );
    const subject = f.root.subject.startsWith('Re:') ? f.root.subject : `Re: ${f.root.subject}`;
    const data = {
      subject,
      body: draft.body.trim(),
      status: 'DRAFT' as const,
      aiGenerated,
      warnings: { items: warnings, usedFact: draft.usedFact, provider: draft.provider } as unknown as Prisma.InputJsonValue,
    };
    const outreach = f.outreachId
      ? await this.prisma.outreach.update({ where: { id: f.outreachId }, data })
      : await (async () => {
          const id = randomUUID();
          return this.prisma.outreach.create({
            data: {
              ...data,
              id,
              userId: f.userId,
              applicationId: f.root.applicationId,
              contactId: f.root.contactId,
              emailAccountId: f.root.emailAccountId,
              rootId: f.rootId,
              kind: 'FOLLOWUP',
              sequence: f.sequence,
              toEmail: f.root.toEmail,
              style: f.root.style,
              attachResume: false,
              messageIdHeader: buildMessageId(id, emailDomain(f.root.messageIdHeader.replace(/[<>]/g, ''))),
            },
          });
        })();
    await this.prisma.followup.update({ where: { id: f.id }, data: { outreachId: outreach.id, status: 'DRAFT_READY' } });
    await this.syncDraft(outreach.id);
    return this.prisma.outreach.findUniqueOrThrow({ where: { id: outreach.id } });
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  async getOwned(userId: string, id: string): Promise<Outreach> {
    const o = await this.prisma.outreach.findFirst({ where: { id, userId } });
    if (!o) throw new NotFoundException('Email not found');
    return o;
  }

  async list(userId: string, filter: { status?: string; kind?: string } = {}) {
    return this.prisma.outreach.findMany({
      where: { userId, ...(filter.status ? { status: filter.status as Outreach['status'] } : {}), ...(filter.kind ? { kind: filter.kind as Outreach['kind'] } : {}) },
      orderBy: [{ updatedAt: 'desc' }],
      take: 200,
      include: {
        contact: { select: { id: true, name: true, role: true, email: true } },
        application: { select: { id: true, status: true, job: { select: { id: true, title: true, company: { select: { name: true } } } } } },
        followupOf: { select: { id: true, sequence: true, scheduledAt: true, status: true } },
      },
    });
  }

  async preview(userId: string, id: string) {
    const o = await this.getOwned(userId, id);
    const guardrails = ['DRAFT', 'APPROVED', 'FAILED'].includes(o.status) ? await this.evaluate({ ...o, status: 'APPROVED' }) : null;
    return { outreach: o, guardrails };
  }
}
