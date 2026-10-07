import type { ApplicationStatus } from '@prisma/client';

/**
 * Allowed application status transitions. Terminal-ish states (REJECTED, CLOSED)
 * can always be reopened to SHORTLISTED manually.
 */
const TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  DISCOVERED: ['QUALIFIED', 'SHORTLISTED', 'APPLIED', 'SKIPPED', 'CLOSED'],
  QUALIFIED: ['SHORTLISTED', 'CONTACT_FOUND', 'RESUME_READY', 'APPLIED', 'SKIPPED', 'CLOSED', 'DISCOVERED'],
  SHORTLISTED: ['CONTACT_FOUND', 'RESUME_READY', 'EMAIL_READY', 'APPLIED', 'QUALIFIED', 'SKIPPED', 'CLOSED'],
  CONTACT_FOUND: ['RESUME_READY', 'EMAIL_READY', 'SHORTLISTED', 'APPLIED', 'SKIPPED', 'CLOSED'],
  RESUME_READY: ['CONTACT_FOUND', 'EMAIL_READY', 'APPLIED', 'SKIPPED', 'CLOSED'],
  EMAIL_READY: ['EMAIL_SENT', 'RESUME_READY', 'CONTACT_FOUND', 'APPLIED', 'SKIPPED', 'CLOSED'],
  /** Applied on the company portal; a cold email may still follow. */
  APPLIED: ['EMAIL_SENT', 'REPLIED', 'INTERVIEW', 'REJECTED', 'OFFER', 'CLOSED'],
  EMAIL_SENT: ['WAITING_FOR_REPLY', 'FOLLOWUP_SCHEDULED', 'REPLIED', 'INTERVIEW', 'REJECTED', 'CLOSED'],
  WAITING_FOR_REPLY: ['FOLLOWUP_SCHEDULED', 'REPLIED', 'INTERVIEW', 'REJECTED', 'CLOSED'],
  FOLLOWUP_SCHEDULED: ['WAITING_FOR_REPLY', 'REPLIED', 'INTERVIEW', 'REJECTED', 'CLOSED'],
  REPLIED: ['INTERVIEW', 'REJECTED', 'OFFER', 'CLOSED'],
  INTERVIEW: ['OFFER', 'REJECTED', 'CLOSED'],
  OFFER: ['CLOSED', 'REJECTED'],
  REJECTED: ['CLOSED', 'SHORTLISTED'],
  CLOSED: ['SHORTLISTED'],
  SKIPPED: ['SHORTLISTED', 'DISCOVERED'],
};

/** Ordered pipeline, used to avoid moving an application "backwards" automatically. */
export const PIPELINE_ORDER: ApplicationStatus[] = [
  'DISCOVERED',
  'QUALIFIED',
  'SHORTLISTED',
  'CONTACT_FOUND',
  'RESUME_READY',
  'EMAIL_READY',
  'APPLIED',
  'EMAIL_SENT',
  'WAITING_FOR_REPLY',
  'FOLLOWUP_SCHEDULED',
  'REPLIED',
  'INTERVIEW',
  'OFFER',
  'REJECTED',
  'CLOSED',
  'SKIPPED',
];

/** Stages before any email is sent. */
const PRE_SEND: ApplicationStatus[] = ['DISCOVERED', 'QUALIFIED', 'SHORTLISTED', 'CONTACT_FOUND', 'RESUME_READY', 'EMAIL_READY'];

export function canTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: ApplicationStatus): ApplicationStatus[] {
  return TRANSITIONS[from];
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: ApplicationStatus,
    public readonly to: ApplicationStatus,
  ) {
    super(`Cannot move application from ${from} to ${to}`);
  }
}

export function assertTransition(from: ApplicationStatus, to: ApplicationStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/**
 * Automatic progress (e.g. "contact found", "resume ready") should only move an
 * application forward through the pre-send stages — never override a later state.
 */
export function shouldAutoAdvance(current: ApplicationStatus, target: ApplicationStatus): boolean {
  if (!PRE_SEND.includes(current) || !PRE_SEND.includes(target)) return false;
  return PIPELINE_ORDER.indexOf(target) > PIPELINE_ORDER.indexOf(current);
}

const TERMINAL: ApplicationStatus[] = ['OFFER', 'REJECTED', 'CLOSED', 'SKIPPED'];

/**
 * System events (email sent, reply received) are facts: they may fast-forward an
 * application through intermediate stages, but never move it backwards and never
 * reopen a terminal application.
 */
export function canSystemAdvance(current: ApplicationStatus, target: ApplicationStatus): boolean {
  if (current === target || TERMINAL.includes(current)) return false;
  if (canTransition(current, target)) return true;
  return PIPELINE_ORDER.indexOf(target) > PIPELINE_ORDER.indexOf(current) && !TERMINAL.includes(target);
}

export function nextActionFor(status: ApplicationStatus): string {
  switch (status) {
    case 'DISCOVERED':
      return 'Review match';
    case 'QUALIFIED':
      return 'Shortlist or skip';
    case 'SHORTLISTED':
      return 'Find a contact';
    case 'CONTACT_FOUND':
      return 'Tailor resume';
    case 'RESUME_READY':
      return 'Generate email';
    case 'EMAIL_READY':
      return 'Review & send email';
    case 'APPLIED':
      return 'Applied — send a cold email if a contact is known';
    case 'EMAIL_SENT':
    case 'WAITING_FOR_REPLY':
      return 'Wait for reply';
    case 'FOLLOWUP_SCHEDULED':
      return 'Follow-up scheduled';
    case 'REPLIED':
      return 'Respond to reply';
    case 'INTERVIEW':
      return 'Prepare for interview';
    case 'OFFER':
      return 'Evaluate offer';
    default:
      return '—';
  }
}

/**
 * Dashboard pipeline status (the simplified vocabulary used by the API):
 * DISCOVERED → VERIFIED → SHORTLISTED → APPLICATION_READY → APPLIED → EMAIL_SENT
 * → FOLLOW_UP_DUE → REPLIED → INTERVIEW → OFFER | REJECTED | SKIPPED.
 * Derived from the detailed internal status so no workflow state is duplicated.
 */
export const PIPELINE_STATUSES = [
  'DISCOVERED',
  'VERIFIED',
  'SHORTLISTED',
  'APPLICATION_READY',
  'APPLIED',
  'EMAIL_SENT',
  'FOLLOW_UP_DUE',
  'REPLIED',
  'INTERVIEW',
  'OFFER',
  'REJECTED',
  'SKIPPED',
] as const;
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

export function pipelineStatus(status: ApplicationStatus, opts: { followupDue?: boolean } = {}): PipelineStatus {
  switch (status) {
    case 'DISCOVERED':
      return 'DISCOVERED';
    case 'QUALIFIED':
      return 'VERIFIED';
    case 'SHORTLISTED':
      return 'SHORTLISTED';
    case 'CONTACT_FOUND':
    case 'RESUME_READY':
    case 'EMAIL_READY':
      return 'APPLICATION_READY';
    case 'APPLIED':
      return 'APPLIED';
    case 'EMAIL_SENT':
    case 'WAITING_FOR_REPLY':
    case 'FOLLOWUP_SCHEDULED':
      return opts.followupDue ? 'FOLLOW_UP_DUE' : 'EMAIL_SENT';
    case 'REPLIED':
      return 'REPLIED';
    case 'INTERVIEW':
      return 'INTERVIEW';
    case 'OFFER':
      return 'OFFER';
    case 'REJECTED':
      return 'REJECTED';
    case 'CLOSED':
    case 'SKIPPED':
      return 'SKIPPED';
  }
}

/** Internal statuses that belong to a dashboard status (for filtering). */
export function internalStatusesFor(p: PipelineStatus): ApplicationStatus[] {
  return (PIPELINE_ORDER as ApplicationStatus[]).filter((s) => pipelineStatus(s) === p || (p === 'FOLLOW_UP_DUE' && pipelineStatus(s) === 'EMAIL_SENT'));
}
