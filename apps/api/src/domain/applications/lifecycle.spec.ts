import type { ApplicationStatus } from '@prisma/client';
import { ACTION_TARGET, lifecycleOf, nextActionFor, STAGE_LABEL, STAGE_OF, stageOf, statusesOfStage } from './lifecycle';
import { allowedTransitions, canSystemAdvance, canTransition, PIPELINE_ORDER, shouldAutoAdvance } from './state-machine';

const ALL = Object.keys(STAGE_OF) as ApplicationStatus[];

describe('application lifecycle', () => {
  it('maps every status to exactly one stage the user can read', () => {
    expect(PIPELINE_ORDER.slice().sort()).toEqual(ALL.slice().sort());
    for (const s of ALL) expect(STAGE_LABEL[stageOf(s)]).toBeTruthy();
    expect(statusesOfStage('APPLIED').sort()).toEqual(['APPLIED', 'EMAIL_SENT', 'FOLLOWUP_SCHEDULED', 'WAITING_FOR_REPLY']);
  });

  it('never calls a job "Applied" because a resume or email draft exists', () => {
    for (const s of ['SHORTLISTED', 'CONTACT_FOUND', 'RESUME_READY', 'EMAIL_READY', 'PREPARING', 'READY_FOR_REVIEW', 'APPROVED'] as const) {
      expect(stageOf(s)).not.toBe('APPLIED');
    }
    expect(stageOf('EMAIL_READY')).toBe('READY_FOR_REVIEW');
    expect(stageOf('CLOSED')).toBe('ARCHIVED');
  });

  it('gives one clear next action, and puts the jobs that need the user first', () => {
    expect(nextActionFor('DISCOVERED', { recommendation: 'STRONG_APPLY' })).toMatchObject({ label: 'Review and decide', needsAction: true, priority: 4 });
    expect(nextActionFor('DISCOVERED', { recommendation: 'SKIP' })).toMatchObject({ needsAction: false, label: 'Not recommended' });
    expect(nextActionFor('SHORTLISTED')).toMatchObject({ label: 'Prepare application', kind: 'prepare' });
    expect(nextActionFor('PREPARING', { workflow: { status: 'IN_PROGRESS', mode: null } })).toMatchObject({ label: 'Preparing…', needsAction: false });
    expect(nextActionFor('PREPARING', { workflow: { status: 'NEEDS_INPUT', mode: null } })).toMatchObject({ label: 'Needs your input', needsAction: true });
    expect(nextActionFor('PREPARING', { workflow: { status: 'FAILED', mode: null } })).toMatchObject({ label: 'Retry failed step', kind: 'retry' });
    expect(nextActionFor('READY_FOR_REVIEW')).toMatchObject({ label: 'Review and approve', needsAction: true });
    expect(nextActionFor('APPROVED', { workflow: { status: 'COMPLETED', mode: 'EXTERNAL' } })).toMatchObject({ label: 'Apply on the company site', needsAction: true });
    expect(nextActionFor('APPROVED', { workflow: { status: 'COMPLETED', mode: 'EMAIL' } })).toMatchObject({ kind: 'wait', needsAction: false });
    expect(nextActionFor('REPLIED').priority).toBeLessThan(nextActionFor('READY_FOR_REVIEW').priority);
    expect(nextActionFor('READY_FOR_REVIEW').priority).toBeLessThan(nextActionFor('SHORTLISTED').priority);
    expect(nextActionFor('SHORTLISTED').priority).toBeLessThan(nextActionFor('DISCOVERED', { recommendation: 'APPLY' }).priority);
    for (const s of ['SKIPPED', 'CLOSED', 'REJECTED'] as const) expect(nextActionFor(s).needsAction).toBe(false);
    expect(lifecycleOf('EMAIL_SENT')).toMatchObject({ stage: 'APPLIED', stageLabel: 'Applied', label: 'Wait for reply' });
  });

  it('every lifecycle action is a valid move from the states where it makes sense', () => {
    expect(canTransition('DISCOVERED', ACTION_TARGET.shortlist)).toBe(true);
    expect(canTransition('SKIPPED', ACTION_TARGET.restore)).toBe(true);
    expect(canTransition('CLOSED', ACTION_TARGET.restore)).toBe(true);
    expect(canTransition('READY_FOR_REVIEW', ACTION_TARGET.mark_applied)).toBe(true);
    expect(canTransition('APPROVED', ACTION_TARGET.mark_applied)).toBe(true);
    expect(canTransition('SHORTLISTED', ACTION_TARGET.skip)).toBe(true);
    expect(canTransition('PREPARING', ACTION_TARGET.skip)).toBe(true);
    // Cannot skip something already approved, sent, or answered (its email thread must keep tracking).
    for (const s of ['APPROVED', 'EMAIL_SENT', 'APPLIED', 'REPLIED', 'INTERVIEW'] as const) expect(canTransition(s, 'SKIPPED')).toBe(false);
    // Every status can still reach a way out.
    for (const s of ALL) expect(allowedTransitions(s).length).toBeGreaterThan(0);
  });

  it('keeps the existing send/reply flows working with the new states', () => {
    // A sent email moves an approved application forward, never a skipped one.
    expect(canSystemAdvance('APPROVED', 'EMAIL_SENT')).toBe(true);
    expect(canSystemAdvance('READY_FOR_REVIEW', 'EMAIL_SENT')).toBe(true); // sent straight from the mailbox draft
    expect(canSystemAdvance('SKIPPED', 'EMAIL_SENT')).toBe(false);
    expect(canSystemAdvance('APPLIED', 'WAITING_FOR_REPLY')).toBe(true);
    expect(canSystemAdvance('WAITING_FOR_REPLY', 'REPLIED')).toBe(true);
    // Individual services must not move an application the preparation workflow owns.
    expect(shouldAutoAdvance('PREPARING', 'CONTACT_FOUND')).toBe(false);
    expect(shouldAutoAdvance('READY_FOR_REVIEW', 'RESUME_READY')).toBe(false);
    expect(shouldAutoAdvance('SHORTLISTED', 'CONTACT_FOUND')).toBe(true); // the old manual flow is unchanged
  });
});
