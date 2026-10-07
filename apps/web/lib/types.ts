export type ApplicationStatus =
  | 'DISCOVERED'
  | 'QUALIFIED'
  | 'SHORTLISTED'
  | 'CONTACT_FOUND'
  | 'RESUME_READY'
  | 'EMAIL_READY'
  | 'EMAIL_SENT'
  | 'WAITING_FOR_REPLY'
  | 'FOLLOWUP_SCHEDULED'
  | 'REPLIED'
  | 'INTERVIEW'
  | 'REJECTED'
  | 'OFFER'
  | 'CLOSED'
  | 'APPLIED'
  | 'SKIPPED';

export const STATUSES: ApplicationStatus[] = [
  'DISCOVERED',
  'QUALIFIED',
  'SHORTLISTED',
  'CONTACT_FOUND',
  'RESUME_READY',
  'EMAIL_READY',
  'APPLIED',
  'EMAIL_SENT',
  'WAITING_FOR_REPLY',
  'FOLLOWUP_SCHEDULED',
  'REPLIED',
  'INTERVIEW',
  'REJECTED',
  'OFFER',
  'CLOSED',
  'SKIPPED',
];

export type Recommendation = 'STRONG_APPLY' | 'APPLY' | 'CONSIDER' | 'LOW_PRIORITY' | 'SKIP';

export interface Contact {
  id: string;
  name: string;
  role: string | null;
  roleCategory: string;
  email: string | null;
  confidence: 'VERIFIED' | 'LIKELY' | 'UNVERIFIED' | 'UNKNOWN';
  source: string;
  sourceUrl: string | null;
  linkedinUrl: string | null;
  notes: string | null;
  rankScore?: number;
  rankReason?: string;
}

export interface Company {
  id: string;
  name: string;
  domain: string | null;
  website: string | null;
  size: 'EARLY_STARTUP' | 'GROWTH_STARTUP' | 'MID_MARKET' | 'ENTERPRISE' | 'UNKNOWN';
  companyType: string | null;
  description: string | null;
  research: Array<{ text: string; sourceUrl: string | null }> | null;
  contacts?: Contact[];
}

export interface ScoreComponent {
  key: string;
  label: string;
  score: number;
  max: number;
  reason: string;
}

export interface MatchResult {
  total: number;
  recommendation: Recommendation;
  components: ScoreComponent[];
  skills: Array<{ skill: string; level: 'strong' | 'partial' | 'learning' | 'missing'; required: boolean; via?: string }>;
  strong: string[];
  partial: string[];
  missing: string[];
  reasons: string[];
  flags: string[];
}

export interface JobAnalysis {
  summary: string;
  fitAssessment: string;
  scoreAdjustment: number;
  adjustmentReason: string;
  recommendation: Recommendation;
  strengths: string[];
  gaps: Array<{ skill: string; severity: string; note: string }>;
  talkingPoints: string[];
  redFlags: string[];
  interviewPrep: string[];
  companyFacts: string[];
  provider?: string;
  fallback?: boolean;
}

export interface Followup {
  id: string;
  sequence: number;
  scheduledAt: string;
  status: string;
  outreachId: string | null;
  cancelReason: string | null;
}

export interface EmailEvent {
  id: string;
  type: string;
  fromEmail: string | null;
  snippet: string | null;
  occurredAt: string;
  metadata: Record<string, unknown>;
}

export interface Outreach {
  id: string;
  kind: 'INITIAL' | 'FOLLOWUP';
  sequence: number;
  toEmail: string;
  subject: string;
  body: string;
  style: string;
  attachResume: boolean;
  status: 'DRAFT' | 'APPROVED' | 'SENDING' | 'SENT' | 'FAILED' | 'CANCELLED';
  threadState: 'NOT_SENT' | 'WAITING_FOR_REPLY' | 'REPLIED' | 'BOUNCED' | 'CLOSED';
  warnings: { items?: string[]; provider?: string; regen?: number } | null;
  error: string | null;
  sentAt: string | null;
  repliedAt: string | null;
  approvedAt: string | null;
  aiGenerated: boolean;
  rootId: string | null;
  gmailDraftId: string | null;
  draftSyncedAt: string | null;
  draftSyncError: string | null;
  followups?: Followup[];
  events?: EmailEvent[];
}

export interface JobDetail {
  id: string;
  title: string;
  url: string | null;
  location: string | null;
  remote: boolean | null;
  description: string;
  provider: string;
  score: number | null;
  recommendation: Recommendation | null;
  scoreBreakdown: MatchResult | null;
  analysis: JobAnalysis | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  createdAt: string;
  postedAt: string | null;
  extracted: { minYears: number | null; workMode: string; seniority: string; locationRestrictions: string[]; visaSponsorship: string } | null;
  company: Company;
  nextAction: string | null;
  application: {
    id: string;
    status: ApplicationStatus;
    contactId: string | null;
    resumeVersionId: string | null;
    replySentiment: string | null;
    notes: string | null;
    contact: Contact | null;
    outreach: Outreach[];
  } | null;
  resumeVersions: Array<{ id: string; createdAt: string; aiAssisted: boolean; compileStatus: string | null; changes: { changes: Array<{ section: string; change: string; reason: string }>; gaps: string[] } }>;
}

export interface JobListItem {
  id: string;
  title: string;
  location: string | null;
  remote: boolean | null;
  url: string | null;
  score: number | null;
  recommendation: Recommendation | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  createdAt: string;
  provider: string;
  company: { id: string; name: string; size: string };
  application: { id: string; status: ApplicationStatus; contact: { id: string; name: string; role: string | null; email: string | null } | null } | null;
  nextAction: string | null;
}
