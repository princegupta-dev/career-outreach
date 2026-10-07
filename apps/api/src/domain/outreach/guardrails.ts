import type { EmailVerificationStatus, OutreachKind } from '@prisma/client';
import type { UserSettings } from '../settings';
import { emailDomain, normalizeCompanyName, normalizeEmail } from '../dedupe';

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
  /** Emails sent in the last 60 minutes (all kinds). */
  sentLastHour?: number;
  /** Emails sent today to the recipient's domain (all kinds). */
  sentToDomainToday?: number;
  /** Verification state of the recipient address. Only PUBLICLY_LISTED / VERIFIED may be emailed. */
  verificationStatus?: EmailVerificationStatus;
  /** Recipient company / domain belongs to the candidate's current employer. */
  isCurrentEmployer?: boolean;
}

/** Addresses that may be emailed. Everything else (UNKNOWN, INVALID, BOUNCED) is blocked. */
export const SENDABLE_VERIFICATION: EmailVerificationStatus[] = ['PUBLICLY_LISTED', 'VERIFIED'];

export function isSendable(status: EmailVerificationStatus | null | undefined): boolean {
  return !!status && SENDABLE_VERIFICATION.includes(status);
}

/**
 * Matches the candidate's current employer by company name or email domain
 * ("almonds.ai" ⇢ "Almonds.ai", "Almonds AI", "@almonds.ai", "@mail.almonds.ai").
 */
export function currentEmployerMatcher(currentCompany: string | null | undefined): (companyName?: string | null, emailOrDomain?: string | null) => boolean {
  const raw = (currentCompany ?? '').trim().toLowerCase();
  if (!raw) return () => false;
  const strip = (n: string) => normalizeCompanyName(n).replace(/\s+(ai|io|com|co|in|app|tech|dev)$/, '').trim();
  const name = strip(raw);
  const domain = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(raw) ? raw.replace(/^www\./, '') : null;
  const label = (domain ?? '').split('.')[0];
  return (companyName, emailOrDomain) => {
    if (companyName && name && strip(companyName) === name) return true;
    const d = (emailOrDomain ?? '').toLowerCase().split('@').pop() ?? '';
    if (!d) return false;
    if (domain && (d === domain || d.endsWith(`.${domain}`))) return true;
    return !!label && label.length > 3 && d.split('.').slice(-2, -1)[0] === label;
  };
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
  if (ctx.isCurrentEmployer) blockers.push('Recipient is at your current employer — never contacted.');
  if (ctx.verificationStatus !== undefined && !isSendable(ctx.verificationStatus)) {
    blockers.push(`Recipient address is ${ctx.verificationStatus.replace(/_/g, ' ').toLowerCase()} — only publicly listed or verified addresses are emailed.`);
  }
  if (ctx.kind === 'INITIAL' && !ctx.approved) blockers.push('Initial emails require your explicit approval.');

  if (ctx.sentToday >= o.dailyLimit) {
    blockers.push(`Daily email limit reached (${o.dailyLimit}).`);
    retryAt = new Date(ctx.now.getTime() + DAY);
  }
  if (ctx.kind === 'INITIAL' && ctx.initialSentToday >= o.dailyInitialLimit) {
    blockers.push(`Daily limit for new outreach reached (${o.dailyInitialLimit}).`);
    retryAt = new Date(ctx.now.getTime() + DAY);
  }
  if ((ctx.sentLastHour ?? 0) >= o.hourlyLimit) {
    blockers.push(`Hourly limit reached (${o.hourlyLimit}/hour).`);
    retryAt = new Date(ctx.now.getTime() + 60 * 60_000);
  }
  if ((ctx.sentToDomainToday ?? 0) >= o.perDomainDailyLimit) {
    blockers.push(`Daily per-domain limit reached for @${emailDomain(ctx.toEmail)} (${o.perDomainDailyLimit}/day).`);
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
  const onlyRetryable = blockers.every((b) => /^(Daily|Spacing|Hourly)/.test(b));
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

/** Random extra delay so queued emails don't leave in bursts (0..maxSeconds). */
export function sendJitterMs(maxSeconds: number, random: () => number = Math.random): number {
  return maxSeconds > 0 ? Math.floor(random() * maxSeconds * 1000) : 0;
}
