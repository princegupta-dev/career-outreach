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
  | 'PREPARING'
  | 'READY_FOR_REVIEW'
  | 'APPROVED'
  | 'APPLIED'
  | 'SKIPPED';

export const STATUSES: ApplicationStatus[] = [
  'DISCOVERED',
  'QUALIFIED',
  'SHORTLISTED',
  'CONTACT_FOUND',
  'RESUME_READY',
  'EMAIL_READY',
  'EMAIL_SENT',
  'WAITING_FOR_REPLY',
  'FOLLOWUP_SCHEDULED',
  'REPLIED',
  'INTERVIEW',
  'REJECTED',
  'OFFER',
  'CLOSED',
  'PREPARING',
  'READY_FOR_REVIEW',
  'APPROVED',
  'APPLIED',
  'SKIPPED',
];

/** What the user sees. The API maps every status to one stage and one next action. */
export type Stage = 'DISCOVERED' | 'SHORTLISTED' | 'PREPARING' | 'READY_FOR_REVIEW' | 'APPROVED' | 'APPLIED' | 'REPLIED' | 'INTERVIEW' | 'OFFER' | 'REJECTED' | 'SKIPPED' | 'ARCHIVED';

export const STAGES: Array<{ id: Stage; label: string }> = [
  { id: 'DISCOVERED', label: 'Discovered' },
  { id: 'SHORTLISTED', label: 'Shortlisted' },
  { id: 'PREPARING', label: 'Preparing' },
  { id: 'READY_FOR_REVIEW', label: 'Ready for review' },
  { id: 'APPROVED', label: 'Approved' },
  { id: 'APPLIED', label: 'Applied' },
  { id: 'REPLIED', label: 'Replied' },
  { id: 'INTERVIEW', label: 'Interview' },
  { id: 'OFFER', label: 'Offer' },
  { id: 'REJECTED', label: 'Rejected' },
  { id: 'SKIPPED', label: 'Skipped' },
  { id: 'ARCHIVED', label: 'Archived' },
];

export interface Lifecycle {
  stage: Stage;
  stageLabel: string;
  status: ApplicationStatus;
  /** The one thing to do next. */
  label: string;
  kind: 'decide' | 'prepare' | 'review' | 'input' | 'retry' | 'apply' | 'respond' | 'wait' | 'none';
  needsAction: boolean;
  priority: number;
}

export type VerdictKey = 'STRONG_MATCH' | 'GOOD_MATCH' | 'REVIEW_MANUALLY' | 'NOT_RECOMMENDED';
export const VERDICTS: Array<{ id: VerdictKey; label: string }> = [
  { id: 'STRONG_MATCH', label: 'Strong match' },
  { id: 'GOOD_MATCH', label: 'Good match' },
  { id: 'REVIEW_MANUALLY', label: 'Review manually' },
  { id: 'NOT_RECOMMENDED', label: 'Not recommended' },
];

export interface Fact {
  known: boolean;
  label: string;
  source?: string;
}

export interface JobSummary {
  verdict: VerdictKey;
  verdictLabel: string;
  score: number | null;
  explanation: string;
  facts: {
    salary: { known: boolean };
    experience: Fact;
    location: Fact & { status: 'open' | 'uncertain' | 'restricted' };
    companySize: Fact;
  };
  whyMatches: string[];
  toVerify: string[];
  skills: { missingRequired: string[]; missingPreferred: string[]; partial: string[] };
}

export type StepStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'NEEDS_INPUT' | 'FAILED';
export type WorkflowStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'READY_FOR_REVIEW' | 'NEEDS_INPUT' | 'FAILED' | 'COMPLETED';

export interface CompanyFactView {
  label: string;
  value: string | null;
  source: string | null;
  sourceUrl: string | null;
  asOf: string | null;
}

export interface PreparationView {
  workflowId: string | null;
  status: WorkflowStatus;
  statusLabel: string;
  mode: 'EMAIL' | 'EXTERNAL' | null;
  steps: Array<{
    key: 'VALIDATE' | 'COMPANY' | 'CONTACT' | 'RESUME' | 'EMAIL';
    label: string;
    status: StepStatus;
    statusLabel: string;
    summary: string | null;
    error: string | null;
    attempts: number;
    needs: { kind: 'confirm_open' | 'confirm_contact'; message: string; contactId?: string } | null;
    finishedAt: string | null;
    skipped: boolean;
  }>;
  stalledHint: string | null;
  review: null | {
    job: { open: string; note: string; checkedAt: string | null; location: string };
    company: CompanyFactView[];
    contact: { id: string; name: string; role: string | null; email: string; confidence: string; source: string; sourceUrl: string | null } | null;
    fallbackRoutes: Array<{ label: string; url: string }>;
    resume: { versionId: string; previewUrl: string; downloadUrl: string; aiAssisted: boolean; reused: boolean; changes: number; gaps: string[] } | null;
    email: { id: string; to: string; subject: string; body: string; status: string; attachResume: boolean; warnings: string[] } | null;
    checklist: string[] | null;
    outstandingChecks: string[];
    canApprove: boolean;
    approveLabel: string;
  };
  events: Array<{ id: string; step: string | null; type: string; message: string; createdAt: string }>;
}

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
  teamSize?: number | null;
  category?: string | null;
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
  eligibility?: string;
  eligibilityFlags?: string[];
  lifecycle: Lifecycle | null;
  summary: JobSummary;
  source?: { id: string; name: string; provider: string } | null;
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
  resumeVersions: Array<{ id: string; createdAt: string; aiAssisted: boolean; compileStatus: string | null; compileLog?: string | null; changes: { changes: Array<{ section: string; change: string; reason: string }>; gaps: string[]; confirmedSkills?: string[]; pages?: number } }>;
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
  eligibility?: string;
  company: { id: string; name: string; size: string; teamSize?: number | null };
  application: { id: string; status: ApplicationStatus; contact: { id: string; name: string; role: string | null; email: string | null } | null } | null;
  nextAction: string | null;
  lifecycle: Lifecycle | null;
  verdict: { key: VerdictKey; label: string };
}

/** Friendly names for where a job came from. */
export const SOURCE_LABEL: Record<string, string> = {
  MANUAL: 'Added by you',
  PASTE: 'Pasted',
  URL: 'Imported link',
  GREENHOUSE: 'Greenhouse',
  LEVER: 'Lever',
  ASHBY: 'Ashby',
  REMOTIVE: 'Remotive',
  HIMALAYAS: 'Himalayas',
  JOBICY: 'Jobicy',
  ARBEITNOW: 'Arbeitnow',
  REMOTEOK: 'Remote OK',
  HN_HIRING: 'Hacker News',
  WWR: 'We Work Remotely',
};
