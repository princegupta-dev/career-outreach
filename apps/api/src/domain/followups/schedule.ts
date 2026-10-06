import type { FollowupStatus, ThreadState } from '@prisma/client';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FollowupPlanItem {
  sequence: number;
  scheduledAt: Date;
}

export interface SendWindow {
  timezone: string;
  startHour: number;
  endHour: number;
  skipWeekends: boolean;
}

/** Local (timezone) calendar parts for a UTC instant. */
function localParts(date: Date, timeZone: string): { hour: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23', weekday: 'short' });
  const parts = fmt.formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
  return { hour, weekday };
}

/** Move a date forward (hour by hour) until it falls inside the send window. */
export function adjustToSendWindow(date: Date, window?: SendWindow): Date {
  if (!window) return date;
  let d = new Date(date);
  for (let i = 0; i < 24 * 8; i++) {
    const { hour, weekday } = localParts(d, window.timezone);
    const weekend = weekday === 0 || weekday === 6;
    if (!(window.skipWeekends && weekend) && hour >= window.startHour && hour < window.endHour) return d;
    d = new Date(d.getTime() + 60 * 60 * 1000);
    d.setUTCMinutes(0, 0, 0);
  }
  return date;
}

/**
 * Build the follow-up plan for a sent initial email. Delays are stored relative to the
 * previous email (default 4 → 5 → 7), i.e. day 4, 9 and 16 after the FIRST email.
 * Each date is anchored to the first email (weekend/send-window shifts don't accumulate).
 */
export function planFollowups(sentAt: Date, delaysDays: number[], window?: SendWindow): FollowupPlanItem[] {
  const plan: FollowupPlanItem[] = [];
  let offset = 0;
  let previous = sentAt.getTime();
  delaysDays.forEach((days, i) => {
    offset += days * DAY_MS;
    let scheduledAt = adjustToSendWindow(new Date(sentAt.getTime() + offset), window);
    if (scheduledAt.getTime() <= previous) scheduledAt = adjustToSendWindow(new Date(previous + DAY_MS), window);
    previous = scheduledAt.getTime();
    plan.push({ sequence: i + 1, scheduledAt });
  });
  return plan;
}

export const MIN_GAP_BETWEEN_FOLLOWUPS_DAYS = 2;

/**
 * Next follow-up date after one was actually sent: keep the original day-N target,
 * but never less than MIN_GAP days after the previous email (if it went out late).
 */
export function rescheduleAfter(firstSentAt: Date, cumulativeDays: number, previousSentAt: Date, window?: SendWindow): Date {
  const target = firstSentAt.getTime() + cumulativeDays * DAY_MS;
  const earliest = previousSentAt.getTime() + MIN_GAP_BETWEEN_FOLLOWUPS_DAYS * DAY_MS;
  return adjustToSendWindow(new Date(Math.max(target, earliest)), window);
}

export type FollowupDecision =
  | { action: 'send' }
  | { action: 'cancel'; reason: string }
  | { action: 'wait'; reason: string };

export interface FollowupCheckInput {
  threadState: ThreadState;
  followupStatus: FollowupStatus;
  scheduledAt: Date;
  now: Date;
  /** Result of a live mailbox check right before sending. */
  replyDetected: boolean;
  suppressed: boolean;
  previousSequenceSent: boolean;
}

/**
 * The single gate every follow-up passes before it is sent.
 * Did the recipient reply? → STOP. Otherwise continue.
 */
export function decideFollowup(input: FollowupCheckInput): FollowupDecision {
  if (input.replyDetected || input.threadState === 'REPLIED') return { action: 'cancel', reason: 'Recipient replied' };
  if (input.threadState === 'BOUNCED') return { action: 'cancel', reason: 'Initial email bounced' };
  if (input.threadState === 'CLOSED') return { action: 'cancel', reason: 'Thread closed' };
  if (input.suppressed) return { action: 'cancel', reason: 'Recipient is on the suppression list' };
  if (input.threadState !== 'WAITING_FOR_REPLY') return { action: 'cancel', reason: `Thread is ${input.threadState}` };
  if (['CANCELLED', 'SENT', 'SKIPPED'].includes(input.followupStatus)) {
    return { action: 'cancel', reason: `Follow-up already ${input.followupStatus.toLowerCase()}` };
  }
  if (!input.previousSequenceSent) return { action: 'wait', reason: 'Previous follow-up not sent yet' };
  if (input.scheduledAt.getTime() > input.now.getTime()) return { action: 'wait', reason: 'Not due yet' };
  return { action: 'send' };
}

/** Follow-up statuses that must be cancelled when a reply arrives. */
export const CANCELLABLE_FOLLOWUP_STATUSES: FollowupStatus[] = ['SCHEDULED', 'DRAFT_READY', 'APPROVED', 'FAILED'];
