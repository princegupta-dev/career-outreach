import { RateLimiter, RateLimitStore } from '../common/rate-limiter';
import { allowedTransitions, assertTransition, canSystemAdvance, canTransition, InvalidTransitionError, shouldAutoAdvance } from './applications/state-machine';
import type { ContactRole, ContactSourceType } from '@prisma/client';
import { categorizeRole, rankContacts } from './contacts/rank';
import { evaluateGuardrails, GuardrailContext, isSuppressed, startOfLocalDay } from './outreach/guardrails';
import { resolveSettings } from './settings';
import { loadProfile } from './__fixtures__/fixtures';
import { ProfileParseError, parseProfileMarkdown } from './profile/profile';

class FakeStore implements RateLimitStore {
  private data = new Map<string, { n: number; expiresAt: number | null }>();
  constructor(private now: () => number) {}
  private live(key: string) {
    const v = this.data.get(key);
    if (v && v.expiresAt !== null && v.expiresAt <= this.now()) this.data.delete(key);
    return this.data.get(key);
  }
  async incr(key: string) {
    const v = this.live(key) ?? { n: 0, expiresAt: null };
    v.n += 1;
    this.data.set(key, v);
    return v.n;
  }
  async pexpire(key: string, ms: number) {
    const v = this.live(key);
    if (!v) return 0;
    v.expiresAt = this.now() + ms;
    return 1;
  }
  async pttl(key: string) {
    const v = this.live(key);
    if (!v) return -2;
    return v.expiresAt === null ? -1 : v.expiresAt - this.now();
  }
}

describe('rate limiter', () => {
  it('allows up to the limit within a window, then blocks, then resets', async () => {
    let t = 0;
    const limiter = new RateLimiter(new FakeStore(() => t));
    for (let i = 0; i < 3; i++) expect((await limiter.hit('login:1.2.3.4', 3, 60_000)).allowed).toBe(true);
    const blocked = await limiter.hit('login:1.2.3.4', 3, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    t = 61_000;
    expect((await limiter.hit('login:1.2.3.4', 3, 60_000)).allowed).toBe(true);
  });

  it('isolates buckets', async () => {
    const limiter = new RateLimiter(new FakeStore(() => 0));
    await limiter.hit('a', 1, 1000);
    expect((await limiter.hit('a', 1, 1000)).allowed).toBe(false);
    expect((await limiter.hit('b', 1, 1000)).allowed).toBe(true);
  });
});

describe('application state machine', () => {
  it('allows forward pipeline transitions', () => {
    expect(canTransition('DISCOVERED', 'QUALIFIED')).toBe(true);
    expect(canTransition('EMAIL_READY', 'EMAIL_SENT')).toBe(true);
    expect(canTransition('WAITING_FOR_REPLY', 'REPLIED')).toBe(true);
    expect(canTransition('REPLIED', 'INTERVIEW')).toBe(true);
    expect(canTransition('INTERVIEW', 'OFFER')).toBe(true);
  });
  it('rejects invalid jumps', () => {
    expect(canTransition('DISCOVERED', 'EMAIL_SENT')).toBe(false);
    expect(canTransition('REPLIED', 'FOLLOWUP_SCHEDULED')).toBe(false);
    expect(canTransition('OFFER', 'EMAIL_READY')).toBe(false);
    expect(() => assertTransition('DISCOVERED', 'OFFER')).toThrow(InvalidTransitionError);
  });
  it('does not auto-advance past or backwards over sent states', () => {
    expect(shouldAutoAdvance('SHORTLISTED', 'CONTACT_FOUND')).toBe(true);
    expect(shouldAutoAdvance('RESUME_READY', 'CONTACT_FOUND')).toBe(false);
    expect(shouldAutoAdvance('WAITING_FOR_REPLY', 'EMAIL_READY')).toBe(false);
  });
  it('lets system events fast-forward but never backwards or out of terminal states', () => {
    expect(canSystemAdvance('DISCOVERED', 'EMAIL_SENT')).toBe(true);
    expect(canSystemAdvance('FOLLOWUP_SCHEDULED', 'REPLIED')).toBe(true);
    expect(canSystemAdvance('INTERVIEW', 'REPLIED')).toBe(false);
    expect(canSystemAdvance('CLOSED', 'REPLIED')).toBe(false);
    expect(canSystemAdvance('REPLIED', 'WAITING_FOR_REPLY')).toBe(false);
  });
  it('allows reopening closed applications', () => {
    expect(allowedTransitions('CLOSED')).toContain('SHORTLISTED');
  });
});

describe('outreach guardrails', () => {
  const settings = resolveSettings({});
  const now = new Date('2026-10-06T08:00:00Z');
  const ctx: GuardrailContext = {
    kind: 'INITIAL',
    toEmail: 'sarah@acme.com',
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
  };

  it('allows a clean, approved initial email', () => {
    expect(evaluateGuardrails(ctx, settings)).toMatchObject({ allowed: true, blockers: [] });
  });
  it('requires approval for initial emails', () => {
    expect(evaluateGuardrails({ ...ctx, approved: false }, settings).blockers.join()).toMatch(/approval/);
  });
  it('enforces the daily limit (retryable)', () => {
    const r = evaluateGuardrails({ ...ctx, sentToday: settings.outreach.dailyLimit }, settings);
    expect(r.allowed).toBe(false);
    expect(r.retryAt).toBeDefined();
  });
  it('blocks duplicate recipients for the same job', () => {
    const r = evaluateGuardrails({ ...ctx, previousToRecipient: [{ sentAt: new Date('2026-09-01'), applicationId: 'a1' }] }, settings);
    expect(r.blockers.join()).toMatch(/already emailed this person about this job/);
  });
  it('enforces recipient and company cooldowns', () => {
    const recent = new Date('2026-10-01T00:00:00Z');
    expect(evaluateGuardrails({ ...ctx, previousToRecipient: [{ sentAt: recent, applicationId: 'a2' }] }, settings).allowed).toBe(false);
    const company = evaluateGuardrails({ ...ctx, previousToCompany: [{ sentAt: recent, applicationId: 'a2', toEmail: 'bob@acme.com' }] }, settings);
    expect(company.allowed).toBe(false);
    const overridden = evaluateGuardrails({ ...ctx, overrideCompanyCooldown: true, previousToCompany: [{ sentAt: recent, applicationId: 'a2', toEmail: 'bob@acme.com' }] }, settings);
    expect(overridden.allowed).toBe(true);
    expect(overridden.warnings).toHaveLength(1);
  });
  it('respects the suppression list (addresses and domains)', () => {
    expect(isSuppressed('Sarah@Acme.com', ['sarah@acme.com'])).toBe(true);
    expect(isSuppressed('bob@acme.com', ['@acme.com'])).toBe(true);
    expect(isSuppressed('bob@acme.com', ['acme.com'])).toBe(true);
    expect(isSuppressed('bob@other.com', ['acme.com'])).toBe(false);
    expect(evaluateGuardrails({ ...ctx, suppressions: ['acme.com'] }, settings).allowed).toBe(false);
  });
  it('enforces spacing between sends', () => {
    const r = evaluateGuardrails({ ...ctx, lastSentAt: new Date(now.getTime() - 30_000) }, settings);
    expect(r.allowed).toBe(false);
    expect(r.retryAt!.getTime()).toBeGreaterThan(now.getTime());
  });
  it('rejects invalid addresses', () => {
    expect(evaluateGuardrails({ ...ctx, toEmail: 'not-an-email' }, settings).allowed).toBe(false);
  });
  it('computes the start of the local day', () => {
    // 2026-10-06 08:00Z is 13:30 IST → local midnight is 2026-10-05 18:30Z
    expect(startOfLocalDay(now, 'Asia/Kolkata').toISOString()).toBe('2026-10-05T18:30:00.000Z');
  });
});

describe('contact ranking', () => {
  it('categorises titles', () => {
    expect(categorizeRole('Engineering Manager, Platform')).toBe('ENGINEERING_MANAGER');
    expect(categorizeRole('Senior Technical Recruiter')).toBe('TECHNICAL_RECRUITER');
    expect(categorizeRole('Co-founder & CEO')).toBe('FOUNDER');
    expect(categorizeRole('CTO')).toBe('CTO');
    expect(categorizeRole('Talent Acquisition Partner')).toBe('RECRUITER');
  });
  it('follows the fixed contact priority: job recruiter → listed hiring manager → posting inbox → careers → hiring → general', () => {
    const c = (id: string, roleCategory: ContactRole, sourceType: ContactSourceType, email: string) => ({ id, roleCategory, sourceType, email, confidence: 'VERIFIED' as const, verificationStatus: 'PUBLICLY_LISTED' as const });
    const ranked = rankContacts([
      c('general', 'OTHER', 'CONTACT_PAGE', 'hello@acme.com'),
      c('careers', 'RECRUITER', 'CAREERS_PAGE', 'careers@acme.com'),
      c('posting-inbox', 'RECRUITER', 'JOB_POSTING', 'jobs@acme.com'),
      c('hm', 'ENGINEERING_MANAGER', 'JOB_POSTING', 'sam@acme.com'),
      c('recruiter', 'TECHNICAL_RECRUITER', 'JOB_POSTING', 'priya@acme.com'),
      c('site-hiring', 'RECRUITER', 'COMPANY_WEBSITE', 'hiring@acme.com'),
    ]);
    expect(ranked.map((r) => r.contact.id)).toEqual(['recruiter', 'hm', 'posting-inbox', 'careers', 'site-hiring', 'general']);
    expect(ranked.map((r) => r.tier)).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it('never ranks an unverified / bounced address above a publicly listed one', () => {
    const ranked = rankContacts([
      { id: 'bounced', roleCategory: 'TECHNICAL_RECRUITER' as const, sourceType: 'JOB_POSTING' as const, email: 'a@x.com', confidence: 'VERIFIED' as const, verificationStatus: 'BOUNCED' as const },
      { id: 'unknown', roleCategory: 'HIRING_MANAGER' as const, sourceType: 'MANUAL' as const, email: 'b@x.com', confidence: 'UNVERIFIED' as const, verificationStatus: 'UNKNOWN' as const },
      { id: 'listed', roleCategory: 'OTHER' as const, sourceType: 'CONTACT_PAGE' as const, email: 'info@x.com', confidence: 'VERIFIED' as const, verificationStatus: 'PUBLICLY_LISTED' as const },
    ]);
    expect(ranked[0].contact.id).toBe('listed');
    expect(ranked.filter((r) => r.sendable).map((r) => r.contact.id)).toEqual(['listed']);
  });
  it('deprioritises contacts without email or with low confidence', () => {
    const ranked = rankContacts(
      [
        { id: 'noemail', roleCategory: 'HIRING_MANAGER' as const, confidence: 'VERIFIED' as const, email: null },
        { id: 'rec', roleCategory: 'RECRUITER' as const, confidence: 'LIKELY' as const, email: 'r@x.com' },
      ],
      'MID_MARKET',
    );
    expect(ranked[0].contact.id).toBe('rec');
  });
});

describe('candidate profile', () => {
  const profile = loadProfile();
  it('loads the canonical profile file', () => {
    expect(profile.name).toBe('Prince Gupta');
    expect(profile.current_title).toBe('Senior Software Engineer');
    expect(profile.strongSkills).toEqual(expect.arrayContaining(['Node.js', 'TypeScript', 'NestJS', 'Redis', 'BullMQ', 'AWS']));
    expect(profile.experienceYears).toBe(3);
    expect(profile.compensation.india_min_lpa).toBe(30);
  });
  it('rejects malformed profiles with a readable error', () => {
    expect(() => parseProfileMarkdown('no frontmatter')).toThrow(ProfileParseError);
    expect(() => parseProfileMarkdown('---\nname: [\n---\n')).toThrow(ProfileParseError);
  });
});
