/** Plain string types that used to come from the Prisma schema. No database any more. */
export type JobProviderKind = 'GREENHOUSE' | 'LEVER' | 'ASHBY' | 'WORKDAY'
  | 'NAUKRI' | 'LINKEDIN' | 'WELLFOUND' | 'HIRIST' | 'INSTAHYRE' | 'INDEED';
export type Recommendation = 'STRONG_APPLY' | 'APPLY' | 'CONSIDER' | 'LOW_PRIORITY' | 'SKIP';
export type CompanySize = 'EARLY_STARTUP' | 'GROWTH_STARTUP' | 'MID_MARKET' | 'ENTERPRISE' | 'UNKNOWN';
export type ContactRole = 'HIRING_MANAGER' | 'ENGINEERING_MANAGER' | 'TECHNICAL_RECRUITER' | 'ENGINEERING_DIRECTOR' | 'RECRUITER' | 'HR' | 'FOUNDER' | 'CTO' | 'ENGINEER' | 'OTHER';
export type ContactConfidence = 'VERIFIED' | 'LIKELY' | 'UNVERIFIED' | 'UNKNOWN';

/** A person to contact, found in public data (e.g. an email published in the job posting). Never guessed. */
export interface ContactCandidate {
  name: string;
  role?: string | null;
  roleCategory: ContactRole;
  email?: string | null;
  linkedinUrl?: string | null;
  source: string;
  sourceUrl?: string | null;
  confidence: ContactConfidence;
}
