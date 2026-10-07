import type { CompanySize, ContactConfidence, ContactRole, ContactSourceType, EmailVerificationStatus } from '@prisma/client';

/** Map a free-text job title to a contact role category. */
export function categorizeRole(title?: string | null): ContactRole {
  const t = (title ?? '').toLowerCase();
  if (!t) return 'OTHER';
  if (/\b(cto|chief technology officer|vp( of)? engineering|head of engineering)\b/.test(t)) return /cto|chief technology/.test(t) ? 'CTO' : 'ENGINEERING_DIRECTOR';
  if (/\b(founder|co-founder|cofounder|ceo|chief executive)\b/.test(t)) return 'FOUNDER';
  if (/\bhiring manager\b/.test(t)) return 'HIRING_MANAGER';
  if (/\b(engineering director|director of engineering|director,? engineering|senior director)\b/.test(t)) return 'ENGINEERING_DIRECTOR';
  if (/\b(engineering manager|software development manager|sdm|manager,? (backend|platform|software|engineering)|team lead|tech lead)\b/.test(t)) return 'ENGINEERING_MANAGER';
  if (/\b(technical recruiter|tech recruiter|engineering recruiter|technical sourcer|technical talent)\b/.test(t)) return 'TECHNICAL_RECRUITER';
  if (/\b(recruiter|talent acquisition|sourcer|talent partner|recruiting)\b/.test(t)) return 'RECRUITER';
  if (/\b(hr|human resources|people (ops|operations|partner)|people team)\b/.test(t)) return 'HR';
  if (/\b(engineer|developer|architect)\b/.test(t)) return 'ENGINEER';
  return 'OTHER';
}

/**
 * Contact priority (lower tier = contact first):
 *   1. recruiter specifically associated with the job (named in the posting)
 *   2. hiring manager / engineering lead / founder publicly listed for the role
 *   3. recruiting / HR inbox published on the job
 *   4. company careers inbox (careers page)
 *   5. company hiring inbox elsewhere on the company site / public business sources
 *   6. general company contact
 * Only addresses that are PUBLICLY_LISTED or VERIFIED can be emailed; everything
 * else sorts after them and is never auto-selected.
 */
export type ContactTier = 1 | 2 | 3 | 4 | 5 | 6;

const PERSON_RECRUITER: ContactRole[] = ['TECHNICAL_RECRUITER', 'RECRUITER'];
const LEADER: ContactRole[] = ['HIRING_MANAGER', 'ENGINEERING_MANAGER', 'ENGINEERING_DIRECTOR', 'CTO', 'FOUNDER'];
const GENERIC_INBOX = /^(careers?|jobs?|hiring|talent|recruit(ing|ment|ers?)?|hr|people|join(us)?|work(withus)?|apply|engineering-jobs|tech-jobs|info|hello|contact|team)$/i;

export function isGenericInbox(email?: string | null): boolean {
  const local = (email ?? '').split('@')[0] ?? '';
  return GENERIC_INBOX.test(local.replace(/[._+-].*$/, ''));
}

export function contactTier(c: Pick<RankableContact, 'roleCategory' | 'sourceType' | 'email'>): ContactTier {
  const generic = isGenericInbox(c.email);
  const src = c.sourceType ?? 'MANUAL';
  if (src === 'JOB_POSTING' || src === 'MANUAL') {
    if (!generic && PERSON_RECRUITER.includes(c.roleCategory)) return 1;
    if (!generic && LEADER.includes(c.roleCategory)) return 2;
    if (src === 'JOB_POSTING') return 3;
  }
  if (src === 'YC_PAGE' && LEADER.includes(c.roleCategory)) return 2;
  if (src === 'CAREERS_PAGE') return 4;
  if (c.roleCategory === 'OTHER' && generic) return 6;
  return 5;
}

const TIER_LABEL: Record<ContactTier, string> = {
  1: 'recruiter named on the job',
  2: 'hiring manager / lead listed for the role',
  3: 'hiring inbox published on the job',
  4: 'company careers inbox',
  5: 'company hiring contact',
  6: 'general company contact',
};

const SENDABLE: EmailVerificationStatus[] = ['PUBLICLY_LISTED', 'VERIFIED'];
const CONFIDENCE_WEIGHT: Record<ContactConfidence, number> = { VERIFIED: 3, LIKELY: 2, UNVERIFIED: 1, UNKNOWN: 0 };

export interface RankableContact {
  id: string;
  roleCategory: ContactRole;
  confidence: ContactConfidence;
  email?: string | null;
  sourceType?: ContactSourceType | null;
  verificationStatus?: EmailVerificationStatus | null;
}

export interface RankedContact<T> {
  contact: T;
  score: number;
  reason: string;
  tier: ContactTier;
  sendable: boolean;
}

/** Ranks contacts by the priority above. `size` is accepted for backwards compatibility and ignored. */
export function rankContacts<T extends RankableContact>(contacts: T[], _size?: CompanySize | null): RankedContact<T>[] {
  return contacts
    .map((c) => {
      const tier = contactTier(c);
      const sendable = !!c.email && SENDABLE.includes(c.verificationStatus ?? 'UNKNOWN');
      // Sendability dominates (2000 > max tier bonus 600 + confidence 30), then priority tier, then confidence.
      const score = (sendable ? 2000 : c.email ? 1000 : 0) + (7 - tier) * 100 + CONFIDENCE_WEIGHT[c.confidence] * 10;
      const reason = [
        `#${tier} ${TIER_LABEL[tier]}`,
        !c.email ? 'no email — cannot be emailed' : sendable ? (c.verificationStatus ?? '').toLowerCase().replace('_', ' ') : `${(c.verificationStatus ?? 'UNKNOWN').toLowerCase()} — not emailed`,
      ].join(', ');
      return { contact: c, score, reason, tier, sendable };
    })
    .sort((a, b) => b.score - a.score);
}
