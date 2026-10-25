import type { ApplicationStatus, Stage } from './types';

/**
 * Mirror of the API's status → stage mapping, used only for badges where the API did not send a
 * lifecycle (e.g. the outreach list). The API stays the source of truth for labels and next actions.
 */
const STAGE_OF: Record<ApplicationStatus, Stage> = {
  DISCOVERED: 'DISCOVERED',
  QUALIFIED: 'DISCOVERED',
  SHORTLISTED: 'SHORTLISTED',
  PREPARING: 'PREPARING',
  CONTACT_FOUND: 'PREPARING',
  RESUME_READY: 'PREPARING',
  EMAIL_READY: 'READY_FOR_REVIEW',
  READY_FOR_REVIEW: 'READY_FOR_REVIEW',
  APPROVED: 'APPROVED',
  EMAIL_SENT: 'APPLIED',
  WAITING_FOR_REPLY: 'APPLIED',
  FOLLOWUP_SCHEDULED: 'APPLIED',
  APPLIED: 'APPLIED',
  REPLIED: 'REPLIED',
  INTERVIEW: 'INTERVIEW',
  OFFER: 'OFFER',
  REJECTED: 'REJECTED',
  SKIPPED: 'SKIPPED',
  CLOSED: 'ARCHIVED',
};

export function stageOfStatus(status: string): Stage | null {
  return STAGE_OF[status as ApplicationStatus] ?? null;
}
