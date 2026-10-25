import type { WorkflowStatus } from '../applications/lifecycle';

/** The preparation workflow, in the order it runs. */
export const STEP_KEYS = ['VALIDATE', 'COMPANY', 'CONTACT', 'RESUME', 'EMAIL'] as const;
export type StepKey = (typeof STEP_KEYS)[number];

export const STEP_LABEL: Record<StepKey, string> = {
  VALIDATE: 'Check the job',
  COMPANY: 'Research the company',
  CONTACT: 'Find a contact',
  RESUME: 'Tailor your resume',
  EMAIL: 'Draft the outreach',
};

export type StepStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'NEEDS_INPUT' | 'FAILED';

/** Plain-language labels shown next to every step. */
export const STEP_STATUS_LABEL: Record<StepStatus, string> = {
  PENDING: 'Not started',
  RUNNING: 'In progress',
  DONE: 'Completed',
  NEEDS_INPUT: 'Needs your input',
  FAILED: 'Failed — retry available',
};

export const WORKFLOW_STATUS_LABEL: Record<WorkflowStatus, string> = {
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  READY_FOR_REVIEW: 'Ready for review',
  NEEDS_INPUT: 'Needs your input',
  FAILED: 'Failed — retry available',
  COMPLETED: 'Completed',
};

/** A step needs the output of these before it can run. */
export const DEPENDENCIES: Partial<Record<StepKey, StepKey[]>> = { EMAIL: ['CONTACT', 'RESUME'] };

export interface StepState {
  status: StepStatus;
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  error?: string;
  /** What the user must decide when status is NEEDS_INPUT. */
  needs?: { kind: 'confirm_open' | 'confirm_contact'; message: string; contactId?: string };
  /** Facts and results (always with their source and time where relevant). */
  data?: Record<string, unknown>;
}

export type Steps = Record<StepKey, StepState>;

export function initialSteps(): Steps {
  return Object.fromEntries(STEP_KEYS.map((k) => [k, { status: 'PENDING', attempts: 0 } satisfies StepState])) as Steps;
}

/** Tolerant read of the stored JSON: unknown or missing steps become PENDING. */
export function normalizeSteps(raw: unknown): Steps {
  const base = initialSteps();
  if (raw && typeof raw === 'object') {
    for (const k of STEP_KEYS) {
      const s = (raw as Record<string, Partial<StepState>>)[k];
      if (s && typeof s === 'object' && s.status) base[k] = { attempts: 0, ...s, status: s.status } as StepState;
    }
  }
  return base;
}

export function isStepKey(v: string): v is StepKey {
  return (STEP_KEYS as readonly string[]).includes(v);
}

/**
 * Steps to run now: not done yet, nothing blocking them, dependencies satisfied.
 * A closed posting that the user has not acknowledged stops everything.
 */
export function runnableSteps(steps: Steps): StepKey[] {
  if (steps.VALIDATE.status === 'NEEDS_INPUT') return [];
  return STEP_KEYS.filter((k) => {
    const st = steps[k].status;
    if (st !== 'PENDING' && st !== 'FAILED') return false;
    return (DEPENDENCIES[k] ?? []).every((d) => steps[d].status === 'DONE');
  });
}

/**
 * Retrying a step makes it (and anything built on it) run again. Independent, finished steps are kept,
 * so a retry never repeats successful work.
 */
export function resetFrom(steps: Steps, key: StepKey): Steps {
  const next = { ...steps };
  const redo = new Set<StepKey>([key]);
  for (const k of STEP_KEYS) if ((DEPENDENCIES[k] ?? []).some((d) => redo.has(d))) redo.add(k);
  for (const k of redo) next[k] = { status: 'PENDING', attempts: steps[k].attempts };
  return next;
}

export function deriveStatus(steps: Steps, ctx: { running?: boolean; approved?: boolean } = {}): WorkflowStatus {
  if (ctx.approved) return 'COMPLETED';
  const all = Object.values(steps);
  if (ctx.running || all.some((s) => s.status === 'RUNNING')) return 'IN_PROGRESS';
  if (all.some((s) => s.status === 'FAILED')) return 'FAILED';
  if (all.some((s) => s.status === 'NEEDS_INPUT')) return 'NEEDS_INPUT';
  if (all.every((s) => s.status === 'DONE')) return 'READY_FOR_REVIEW';
  if (all.every((s) => s.status === 'PENDING')) return 'NOT_STARTED';
  return 'IN_PROGRESS';
}
