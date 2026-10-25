import { deriveStatus, initialSteps, normalizeSteps, resetFrom, runnableSteps, STEP_STATUS_LABEL, Steps } from './steps';

const done = (s: Steps, ...keys: Array<keyof Steps>) => {
  for (const k of keys) s[k] = { ...s[k], status: 'DONE' };
  return s;
};

describe('preparation workflow rules', () => {
  it('starts with everything not started, in order', () => {
    const s = initialSteps();
    expect(Object.values(s).every((x) => x.status === 'PENDING')).toBe(true);
    expect(deriveStatus(s)).toBe('NOT_STARTED');
    expect(runnableSteps(s)).toEqual(['VALIDATE', 'COMPANY', 'CONTACT', 'RESUME']); // EMAIL waits for contact + resume
  });

  it('uses the plain labels the page shows', () => {
    expect(STEP_STATUS_LABEL).toEqual({ PENDING: 'Not started', RUNNING: 'In progress', DONE: 'Completed', NEEDS_INPUT: 'Needs your input', FAILED: 'Failed — retry available' });
  });

  it('the email step only becomes runnable once its contact and resume are done', () => {
    const s = done(initialSteps(), 'VALIDATE', 'COMPANY', 'CONTACT');
    expect(runnableSteps(s)).toEqual(['RESUME']);
    expect(runnableSteps(done(s, 'RESUME'))).toEqual(['EMAIL']);
  });

  it('a closed posting that was not acknowledged stops every other step', () => {
    const s = initialSteps();
    s.VALIDATE = { status: 'NEEDS_INPUT', attempts: 1 };
    expect(runnableSteps(s)).toEqual([]);
    expect(deriveStatus(s)).toBe('NEEDS_INPUT');
  });

  it('derives the overall status from the steps (failed beats needs-input beats ready)', () => {
    const s = done(initialSteps(), 'VALIDATE', 'COMPANY', 'CONTACT', 'RESUME', 'EMAIL');
    expect(deriveStatus(s)).toBe('READY_FOR_REVIEW');
    expect(deriveStatus(s, { approved: true })).toBe('COMPLETED');
    const failed = { ...s, RESUME: { status: 'FAILED' as const, attempts: 1, error: 'boom' } };
    const needs = { ...failed, CONTACT: { status: 'NEEDS_INPUT' as const, attempts: 1 } };
    expect(deriveStatus(failed)).toBe('FAILED');
    expect(deriveStatus(needs)).toBe('FAILED');
    expect(deriveStatus({ ...s, RESUME: { status: 'RUNNING', attempts: 1 } })).toBe('IN_PROGRESS');
    expect(deriveStatus({ ...s, CONTACT: { status: 'NEEDS_INPUT', attempts: 1 } })).toBe('NEEDS_INPUT');
  });

  it('retrying a step redoes only that step and what is built on it', () => {
    const all = done(initialSteps(), 'VALIDATE', 'COMPANY', 'CONTACT', 'RESUME', 'EMAIL');
    const afterResume = resetFrom(all, 'RESUME');
    expect(afterResume.VALIDATE.status).toBe('DONE');
    expect(afterResume.COMPANY.status).toBe('DONE');
    expect(afterResume.CONTACT.status).toBe('DONE');
    expect(afterResume.RESUME.status).toBe('PENDING');
    expect(afterResume.EMAIL.status).toBe('PENDING'); // the draft attaches the resume
    expect(runnableSteps(afterResume)).toEqual(['RESUME']);
    const afterCompany = resetFrom(all, 'COMPANY');
    expect(afterCompany.EMAIL.status).toBe('DONE'); // nothing depends on it
    expect(afterCompany.RESUME.attempts).toBe(0);
  });

  it('keeps the number of attempts when a step is reset, and tolerates damaged stored data', () => {
    const s = initialSteps();
    s.RESUME = { status: 'FAILED', attempts: 2, error: 'x' };
    expect(resetFrom(s, 'RESUME').RESUME).toEqual({ status: 'PENDING', attempts: 2 });
    expect(normalizeSteps(null).VALIDATE.status).toBe('PENDING');
    expect(normalizeSteps({ RESUME: { status: 'DONE' }, NOPE: {} }).RESUME.status).toBe('DONE');
    expect(normalizeSteps('garbage').EMAIL.status).toBe('PENDING');
  });
});
