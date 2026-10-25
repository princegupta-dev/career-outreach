import type { ApplicationStatus, Recommendation } from '@prisma/client';

/**
 * The lifecycle the user sees. The database keeps its finer-grained statuses (the send, reply and
 * follow-up code depends on them); every status maps to exactly one of these stages.
 *
 *   Discovered → Shortlisted → Preparing → Ready for review → Approved → Applied → Replied → Interview → Offer / Rejected
 *   plus Skipped and Archived.
 */
export type Stage = 'DISCOVERED' | 'SHORTLISTED' | 'PREPARING' | 'READY_FOR_REVIEW' | 'APPROVED' | 'APPLIED' | 'REPLIED' | 'INTERVIEW' | 'OFFER' | 'REJECTED' | 'SKIPPED' | 'ARCHIVED';

export const STAGES: Stage[] = ['DISCOVERED', 'SHORTLISTED', 'PREPARING', 'READY_FOR_REVIEW', 'APPROVED', 'APPLIED', 'REPLIED', 'INTERVIEW', 'OFFER', 'REJECTED', 'SKIPPED', 'ARCHIVED'];

export const STAGE_LABEL: Record<Stage, string> = {
  DISCOVERED: 'Discovered',
  SHORTLISTED: 'Shortlisted',
  PREPARING: 'Preparing',
  READY_FOR_REVIEW: 'Ready for review',
  APPROVED: 'Approved',
  APPLIED: 'Applied',
  REPLIED: 'Replied',
  INTERVIEW: 'Interview',
  OFFER: 'Offer',
  REJECTED: 'Rejected',
  SKIPPED: 'Skipped',
  ARCHIVED: 'Archived',
};

/** Note: a generated resume or email draft never means "Applied" — only a sent email or the user's confirmation does. */
export const STAGE_OF: Record<ApplicationStatus, Stage> = {
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

export function stageOf(status: ApplicationStatus): Stage {
  return STAGE_OF[status];
}

export function statusesOfStage(stage: Stage): ApplicationStatus[] {
  return (Object.keys(STAGE_OF) as ApplicationStatus[]).filter((s) => STAGE_OF[s] === stage);
}

export type WorkflowStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'READY_FOR_REVIEW' | 'NEEDS_INPUT' | 'FAILED' | 'COMPLETED';

export interface ActionContext {
  recommendation?: Recommendation | null;
  workflow?: { status: string; mode: string | null } | null;
}

export type ActionKind = 'decide' | 'prepare' | 'review' | 'input' | 'retry' | 'apply' | 'respond' | 'wait' | 'none';

export interface NextAction {
  label: string;
  kind: ActionKind;
  /** Something is waiting for the user. */
  needsAction: boolean;
  /** 1 = most urgent … 9 = nothing to do. Used to put jobs that need you first. */
  priority: number;
}

const none = (label = '—'): NextAction => ({ label, kind: 'none', needsAction: false, priority: 9 });
const wait = (label: string): NextAction => ({ label, kind: 'wait', needsAction: false, priority: 8 });

/** One clear next action for an application, from its status and (when relevant) its preparation workflow. */
export function nextActionFor(status: ApplicationStatus, ctx: ActionContext = {}): NextAction {
  const rec = ctx.recommendation ?? null;
  const wf = ctx.workflow ?? null;
  switch (status) {
    case 'DISCOVERED':
    case 'QUALIFIED':
      if (rec === 'STRONG_APPLY' || rec === 'APPLY') return { label: 'Review and decide', kind: 'decide', needsAction: true, priority: 4 };
      if (rec === 'CONSIDER' || rec == null) return { label: 'Review manually', kind: 'decide', needsAction: true, priority: 5 };
      return none('Not recommended');
    case 'SHORTLISTED':
      return { label: 'Prepare application', kind: 'prepare', needsAction: true, priority: 3 };
    case 'PREPARING':
    case 'CONTACT_FOUND':
    case 'RESUME_READY':
      if (wf?.status === 'IN_PROGRESS') return wait('Preparing…');
      if (wf?.status === 'NEEDS_INPUT') return { label: 'Needs your input', kind: 'input', needsAction: true, priority: 2 };
      if (wf?.status === 'FAILED') return { label: 'Retry failed step', kind: 'retry', needsAction: true, priority: 2 };
      return { label: 'Finish preparing', kind: 'prepare', needsAction: true, priority: 3 };
    case 'READY_FOR_REVIEW':
    case 'EMAIL_READY':
      return { label: 'Review and approve', kind: 'review', needsAction: true, priority: 2 };
    case 'APPROVED':
      return wf?.mode === 'EXTERNAL' ? { label: 'Apply on the company site', kind: 'apply', needsAction: true, priority: 2 } : wait('Email queued to send');
    case 'EMAIL_SENT':
    case 'WAITING_FOR_REPLY':
    case 'APPLIED':
      return wait('Wait for reply');
    case 'FOLLOWUP_SCHEDULED':
      return wait('Follow-up scheduled');
    case 'REPLIED':
      return { label: 'Respond to reply', kind: 'respond', needsAction: true, priority: 1 };
    case 'INTERVIEW':
      return { label: 'Prepare for interview', kind: 'respond', needsAction: true, priority: 1 };
    case 'OFFER':
      return { label: 'Evaluate offer', kind: 'respond', needsAction: true, priority: 1 };
    default:
      return none();
  }
}

export interface Lifecycle extends NextAction {
  stage: Stage;
  stageLabel: string;
  status: ApplicationStatus;
}

export function lifecycleOf(status: ApplicationStatus, ctx: ActionContext = {}): Lifecycle {
  const stage = stageOf(status);
  return { ...nextActionFor(status, ctx), stage, stageLabel: STAGE_LABEL[stage], status };
}

/** Explicit user actions on the lifecycle (each maps to one validated status change). */
export type LifecycleAction = 'shortlist' | 'skip' | 'restore' | 'archive' | 'mark_applied';

export const ACTION_TARGET: Record<LifecycleAction, ApplicationStatus> = {
  shortlist: 'SHORTLISTED',
  restore: 'SHORTLISTED',
  skip: 'SKIPPED',
  archive: 'CLOSED',
  mark_applied: 'APPLIED',
};
