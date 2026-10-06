import type { CompanySize, ContactConfidence, ContactRole } from '@prisma/client';

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
 * Contact priority by company size. Lower index = contact first.
 * Small startups: founders / CTO / eng leads read their own inbox.
 * Large companies: recruiters and hiring managers own the pipeline.
 */
const PRIORITY: Record<'small' | 'mid' | 'large', ContactRole[]> = {
  small: ['CTO', 'FOUNDER', 'HIRING_MANAGER', 'ENGINEERING_MANAGER', 'ENGINEERING_DIRECTOR', 'TECHNICAL_RECRUITER', 'RECRUITER', 'HR', 'ENGINEER', 'OTHER'],
  mid: ['HIRING_MANAGER', 'ENGINEERING_MANAGER', 'TECHNICAL_RECRUITER', 'ENGINEERING_DIRECTOR', 'RECRUITER', 'CTO', 'HR', 'FOUNDER', 'ENGINEER', 'OTHER'],
  large: ['HIRING_MANAGER', 'TECHNICAL_RECRUITER', 'ENGINEERING_MANAGER', 'RECRUITER', 'ENGINEERING_DIRECTOR', 'HR', 'CTO', 'FOUNDER', 'ENGINEER', 'OTHER'],
};

function bucket(size?: CompanySize | null): 'small' | 'mid' | 'large' {
  if (size === 'EARLY_STARTUP') return 'small';
  if (size === 'ENTERPRISE') return 'large';
  return 'mid';
}

const CONFIDENCE_WEIGHT: Record<ContactConfidence, number> = { VERIFIED: 30, LIKELY: 18, UNVERIFIED: 6, UNKNOWN: 0 };

export interface RankableContact {
  id: string;
  roleCategory: ContactRole;
  confidence: ContactConfidence;
  email?: string | null;
}

export interface RankedContact<T> {
  contact: T;
  score: number;
  reason: string;
}

export function rankContacts<T extends RankableContact>(contacts: T[], size?: CompanySize | null): RankedContact<T>[] {
  const order = PRIORITY[bucket(size)];
  return contacts
    .map((c) => {
      const idx = order.indexOf(c.roleCategory);
      const roleScore = (order.length - (idx < 0 ? order.length : idx)) * 7;
      const emailScore = c.email ? 10 : -40;
      const score = roleScore + CONFIDENCE_WEIGHT[c.confidence] + emailScore;
      const reason = [
        `${c.roleCategory.replace(/_/g, ' ').toLowerCase()} (#${idx + 1} priority for ${bucket(size)} companies)`,
        `${c.confidence.toLowerCase()} contact`,
        c.email ? 'has email' : 'no email — cannot be emailed',
      ].join(', ');
      return { contact: c, score, reason };
    })
    .sort((a, b) => b.score - a.score);
}
