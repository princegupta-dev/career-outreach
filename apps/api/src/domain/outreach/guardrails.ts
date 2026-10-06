import type { OutreachKind } from '@prisma/client';
import type { UserSettings } from '../settings';
import { emailDomain, normalizeEmail } from '../dedupe';

/** Snapshot of facts the guardrails need — gathered from the DB by the caller. */
export interface GuardrailContext {
  kind: OutreachKind;
  toEmail: string;
  companyId: string;
  now: Date;
  /** Emails already sent today (user's timezone), all kinds. */
  sentToday: number;
  /** Initial emails already sent today. */
  initialSentToday: number;
  /** Last time anything was sent (for spacing). */
  lastSentAt: Date | null;
  /** Previous INITIAL emails to this exact address (other applications included). */
  previousToRecipient: Array<{ sentAt: Date; applicationId: string }>;
  /** Previous INITIAL emails to anyone at this company. */
  previousToCompany: Array<{ sentAt: Date; applicationId: string; toEmail: string }>;
  applicationId: string;
  /** Suppressed addresses and domains for this user. */
  suppressions: string[];
  /** Has the user explicitly approved this email? */
  approved: boolean;
  /** Allows skipping the company cooldown (explicit user override). */
  overrideCompanyCooldown?: boolean;
}

export interface GuardrailResult {
  allowed: boolean;
  /** Blocking reasons — sending must not proceed. */
  blockers: string[];
  /** Non-blocking notes shown to the user. */
  warnings: string[];
  /** If blocked only by spacing/limits, when it is OK to retry. */
  retryAt?: Date;
}

const DAY = 24 * 60 * 60 * 1000;

export function isSuppressed(email: string, suppressions: string[]): boolean {
  const e = normalizeEmail(email);
  const d = emailDomain(e);
  return suppressions.some((s) => {
    const v = s.trim().toLowerCase();
    return v === e || (v.startsWith('@') ? v.slice(1) === d : v === d);
  });
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(email.trim()) && email.length <= 254;
}

/** Pure policy: decides whether an email may be sent right now. */
export function evaluateGuardrails(ctx: GuardrailContext, settings: UserSettings): GuardrailResult {
  const blockers: string[] = [];
  const warnings: string[] = [];
  let retryAt: Date | undefined;
  const o = settings.outreach;

  if (!isValidEmail(ctx.toEmail)) blockers.push(`"${ctx.toEmail}" is not a valid email address.`);
  if (isSuppressed(ctx.toEmail, ctx.suppressions)) blockers.push('Recipient is on your suppression list.');
  if (ctx.kind === 'INITIAL' && !ctx.approved) blockers.push('Initial emails require your explicit approval.');

  if (ctx.sentToday >= o.dailyLimit) {
    blockers.push(`Daily email limit reached (${o.dailyLimit}).`);
    retryAt = new Date(ctx.now.getTime() + DAY);
  }
  if (ctx.kind === 'INITIAL' && ctx.initialSentToday >= o.dailyInitialLimit) {
    blockers.push(`Daily limit for new outreach reached (${o.dailyInitialLimit}).`);
    retryAt = new Date(ctx.now.getTime() + DAY);
  }
  if (ctx.lastSentAt && o.minMinutesBetweenSends > 0) {
    const next = ctx.lastSentAt.getTime() + o.minMinutesBetweenSends * 60_000;
    if (next > ctx.now.getTime()) {
      blockers.push(`Spacing: waiting ${o.minMinutesBetweenSends} min between sends.`);
      retryAt = new Date(next);
    }
  }

  if (ctx.kind === 'INITIAL') {
    const sameApp = ctx.previousToRecipient.filter((p) => p.applicationId === ctx.applicationId);
    if (sameApp.length) blockers.push('You already emailed this person about this job.');
    const recent = ctx.previousToRecipient.filter((p) => ctx.now.getTime() - p.sentAt.getTime() < o.recipientCooldownDays * DAY);
    if (recent.length && !sameApp.length) {
      blockers.push(`You emailed this person ${Math.floor((ctx.now.getTime() - recent[0].sentAt.getTime()) / DAY)} days ago (cooldown ${o.recipientCooldownDays} days).`);
    }
    const companyRecent = ctx.previousToCompany.filter(
      (p) => p.applicationId !== ctx.applicationId && ctx.now.getTime() - p.sentAt.getTime() < o.companyCooldownDays * DAY,
    );
    if (companyRecent.length) {
      const msg = `You contacted someone at this company ${Math.floor((ctx.now.getTime() - companyRecent[0].sentAt.getTime()) / DAY)} days ago (${companyRecent[0].toEmail}).`;
      if (ctx.overrideCompanyCooldown) warnings.push(`${msg} Sending anyway (override).`);
      else blockers.push(`${msg} Company cooldown is ${o.companyCooldownDays} days — override explicitly if this is intentional.`);
    }
  }

  // Only spacing/limit blockers are retryable.
  const onlyRetryable = blockers.every((b) => /^(Daily|Spacing)/.test(b));
  return { allowed: blockers.length === 0, blockers, warnings, retryAt: onlyRetryable ? retryAt : undefined };
}

/** Start of "today" in the user's timezone, as a UTC Date. */
export function startOfLocalDay(now: Date, timeZone: string): Date {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  const localAsUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  const offset = localAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  const localMidnightAsUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
  return new Date(localMidnightAsUtc - offset);
}
