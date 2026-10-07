import { BACKEND_JD, loadProfile } from './__fixtures__/fixtures';
import { canTransition, pipelineStatus, internalStatusesFor } from './applications/state-machine';
import { jobDedupeKey, normalizeLocation, normalizeRole } from './dedupe';
import { decisionFor, freshnessScore, scoreJob, WEIGHTS } from './matching/scorer';
import { currentEmployerMatcher, evaluateGuardrails, GuardrailContext, isSendable, sendJitterMs } from './outreach/guardrails';
import { resolveSettings } from './settings';
import { extractJob } from './skills/extract';

const profile = loadProfile();
const now = new Date('2026-10-07T10:00:00Z');

describe('dedupe key (company + role + location)', () => {
  it('treats city aliases, seniority abbreviations and punctuation as the same posting', () => {
    const a = jobDedupeKey({ companyName: 'Acme Technologies Pvt. Ltd.', title: 'Sr. Backend Engineer (Node.js)', location: 'Bengaluru, Karnataka, India' });
    const b = jobDedupeKey({ companyName: 'Acme', title: 'Senior Backend Engineer - Node.js', location: 'Bangalore, India' });
    expect(a).toBe(b);
  });
  it('keeps different seniority / city as different jobs', () => {
    const base = { companyName: 'Acme', title: 'Senior Backend Engineer', location: 'Pune' };
    expect(jobDedupeKey(base)).not.toBe(jobDedupeKey({ ...base, title: 'Backend Engineer' }));
    expect(jobDedupeKey(base)).not.toBe(jobDedupeKey({ ...base, location: 'Hyderabad' }));
  });
  it('normalises roles and locations', () => {
    expect(normalizeRole('Sr. Software Engineer (m/f/d)')).toBe('senior software engineer');
    expect(normalizeLocation('Gurugram, Haryana, India')).toBe(normalizeLocation('Gurgaon'));
    expect(normalizeLocation('Remote — India')).toBe('remote');
  });
});

describe('scoring weights and output', () => {
  const ex = extractJob({ title: 'Senior Backend Engineer', description: BACKEND_JD });
  it('uses the 30/20/15/10/10/5/5/5 weights', () => {
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    const r = scoreJob({ title: 'Senior Backend Engineer', companyName: 'Acme', extraction: ex, postedAt: now }, profile, now);
    expect(Object.fromEntries(r.components.map((c) => [c.key, c.max]))).toEqual(WEIGHTS);
    expect(r.breakdown).toMatchObject({
      score: r.total,
      technical_score: expect.any(Number),
      seniority_score: 20,
      role_score: 15,
      freshness_score: 5,
      recommendation: 'APPLY',
    });
    expect(r.breakdown.strong_matches).toEqual(expect.arrayContaining(['Node.js', 'TypeScript', 'Redis']));
  });
  it('does not penalise an undisclosed salary', () => {
    const r = scoreJob({ title: 'Senior Backend Engineer', companyName: 'Acme', extraction: { ...ex, salary: null } }, profile, now);
    expect(r.components.find((c) => c.key === 'compensation')!.score).toBeGreaterThanOrEqual(7);
    expect(r.decision).toBe('APPLY');
  });
  it('awards freshness by posting age', () => {
    const h = (n: number) => new Date(now.getTime() - n * 3600_000);
    expect([freshnessScore(h(2), now), freshnessScore(h(48), now), freshnessScore(h(120), now), freshnessScore(h(24 * 40), now), freshnessScore(null, now)].map((f) => f.score)).toEqual([5, 4, 3, 0, 2]);
  });
  it('gives AI relevance credit only for AI work the profile actually covers', () => {
    const genai = extractJob({ title: 'AI Backend Engineer', description: `${BACKEND_JD}\nYou will integrate LLMs (OpenAI / Anthropic) into our backend.` });
    const ml = extractJob({ title: 'Backend Engineer', description: `${BACKEND_JD}\nRequirements: 3+ years of machine learning, PyTorch model training.` });
    const ai = (e: typeof ex) => scoreJob({ title: 'Backend Engineer', companyName: 'Acme', extraction: e }, profile, now).components.find((c) => c.key === 'ai')!.score;
    expect(ai(genai)).toBe(5);
    expect(ai(ml)).toBeLessThan(ai(ex));
  });
  it('never recommends the current employer', () => {
    const r = scoreJob({ title: 'Senior Backend Engineer', companyName: 'Almonds AI', extraction: ex }, profile, now);
    expect(r.recommendation).toBe('SKIP');
    expect(r.reasons.join(' ')).toMatch(/current employer/);
  });
  it('maps recommendations to APPLY / CONSIDER / SKIP', () => {
    expect([decisionFor('STRONG_APPLY'), decisionFor('APPLY'), decisionFor('CONSIDER'), decisionFor('LOW_PRIORITY'), decisionFor('SKIP')]).toEqual(['APPLY', 'APPLY', 'CONSIDER', 'SKIP', 'SKIP']);
  });
});

describe('send guardrails', () => {
  const settings = resolveSettings({});
  const ctx = (over: Partial<GuardrailContext> = {}): GuardrailContext => ({
    kind: 'INITIAL',
    toEmail: 'jobs@acme.com',
    companyId: 'c1',
    now,
    sentToday: 0,
    initialSentToday: 0,
    lastSentAt: null,
    previousToRecipient: [],
    previousToCompany: [],
    applicationId: 'a1',
    suppressions: [],
    approved: true,
    verificationStatus: 'PUBLICLY_LISTED',
    ...over,
  });

  it('defaults to APPROVAL_REQUIRED with conservative limits', () => {
    expect(settings.outreach).toMatchObject({ sendMode: 'APPROVAL_REQUIRED', hourlyLimit: 4, perDomainDailyLimit: 2, dailyLimit: 15 });
  });
  it('only sends to PUBLICLY_LISTED or VERIFIED addresses', () => {
    expect(['UNKNOWN', 'PUBLICLY_LISTED', 'VERIFIED', 'INVALID', 'BOUNCED'].filter((s) => isSendable(s as never))).toEqual(['PUBLICLY_LISTED', 'VERIFIED']);
    for (const s of ['UNKNOWN', 'INVALID', 'BOUNCED'] as const) {
      const r = evaluateGuardrails(ctx({ verificationStatus: s }), settings);
      expect(r.allowed).toBe(false);
      expect(r.retryAt).toBeUndefined();
    }
    expect(evaluateGuardrails(ctx(), settings).allowed).toBe(true);
  });
  it('enforces hourly and per-domain limits as retryable', () => {
    const hourly = evaluateGuardrails(ctx({ sentLastHour: 4 }), settings);
    expect(hourly.allowed).toBe(false);
    expect(hourly.retryAt).toBeDefined();
    const domain = evaluateGuardrails(ctx({ sentToDomainToday: 2 }), settings);
    expect(domain.blockers.join(' ')).toMatch(/per-domain/);
    expect(domain.retryAt).toBeDefined();
  });
  it('never emails the current employer', () => {
    const match = currentEmployerMatcher('almonds.ai');
    expect([match('Almonds.ai'), match('Almonds AI'), match(null, 'hr@almonds.ai'), match(null, 'x@mail.almonds.ai'), match('Acme', 'jobs@acme.com')]).toEqual([true, true, true, true, false]);
    expect(evaluateGuardrails(ctx({ isCurrentEmployer: true }), settings).blockers.join(' ')).toMatch(/current employer/);
  });
  it('blocks suppressed domains', () => {
    expect(evaluateGuardrails(ctx({ suppressions: ['@acme.com'] }), settings).allowed).toBe(false);
  });
  it('jitter stays within the configured bound', () => {
    expect(sendJitterMs(120, () => 0.999)).toBeLessThan(120_000);
    expect(sendJitterMs(0)).toBe(0);
  });
});

describe('application statuses', () => {
  it('maps internal states to the dashboard vocabulary', () => {
    expect(pipelineStatus('QUALIFIED')).toBe('VERIFIED');
    expect(pipelineStatus('EMAIL_READY')).toBe('APPLICATION_READY');
    expect(pipelineStatus('WAITING_FOR_REPLY')).toBe('EMAIL_SENT');
    expect(pipelineStatus('FOLLOWUP_SCHEDULED', { followupDue: true })).toBe('FOLLOW_UP_DUE');
    expect(pipelineStatus('CLOSED')).toBe('SKIPPED');
    expect(internalStatusesFor('APPLICATION_READY')).toEqual(['CONTACT_FOUND', 'RESUME_READY', 'EMAIL_READY']);
  });
  it('allows recording a portal application and skipping', () => {
    expect(canTransition('SHORTLISTED', 'APPLIED')).toBe(true);
    expect(canTransition('APPLIED', 'EMAIL_SENT')).toBe(true);
    expect(canTransition('DISCOVERED', 'SKIPPED')).toBe(true);
    expect(canTransition('SKIPPED', 'EMAIL_SENT')).toBe(false);
  });
});
