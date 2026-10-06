import { z } from 'zod';
import type { GenerateEmailInput } from '../../domain/email/voice';
import type { MatchResult } from '../../domain/matching/scorer';
import type { CandidateProfile } from '../../domain/profile/profile';

export const AI_PROVIDER = Symbol('AI_PROVIDER');

// ─── Job analysis ────────────────────────────────────────────────────────────

export const jobAnalysisSchema = z.object({
  summary: z.string().describe('2-3 sentences: what this role actually is'),
  fitAssessment: z.string().describe('Honest assessment of fit, grounded in the profile'),
  scoreAdjustment: z.number().int().min(-10).max(10).describe('Semantic adjustment to the deterministic score'),
  adjustmentReason: z.string(),
  recommendation: z.enum(['STRONG_APPLY', 'APPLY', 'CONSIDER', 'LOW_PRIORITY', 'SKIP']),
  strengths: z.array(z.string()).describe('Strengths with evidence from the profile only'),
  gaps: z.array(z.object({ skill: z.string(), severity: z.enum(['blocker', 'notable', 'minor']), note: z.string() })),
  talkingPoints: z.array(z.string()).describe('Truthful points to use in outreach'),
  redFlags: z.array(z.string()),
  interviewPrep: z.array(z.string()).describe('Topics to prepare for interviews'),
  companyFacts: z.array(z.string()).describe('Facts about the company stated in the job description only'),
});
export type JobAnalysis = z.infer<typeof jobAnalysisSchema>;

export interface AnalyzeJobInput {
  profile: CandidateProfile;
  jobTitle: string;
  companyName: string;
  description: string;
  match: MatchResult;
}

// ─── Resume tailoring ────────────────────────────────────────────────────────

export const tailoredBulletsSchema = z.object({
  rewrites: z.array(z.object({ id: z.string(), text: z.string(), reason: z.string() })),
});
export type TailoredBullets = z.infer<typeof tailoredBulletsSchema>;

export interface TailorResumeInput {
  profile: CandidateProfile;
  jobTitle: string;
  companyName: string;
  jobSkills: string[];
  description: string;
  bullets: Array<{ id: string; text: string; roleTechnologies: string[] }>;
}

// ─── Emails ──────────────────────────────────────────────────────────────────

export const emailDraftSchema = z.object({
  subject: z.string(),
  body: z.string(),
});
export type EmailDraft = z.infer<typeof emailDraftSchema> & { provider: string; usedFact?: string };

export interface GenerateEmailRequest {
  profile: CandidateProfile;
  input: GenerateEmailInput;
  /** Problems from a previous attempt (for one corrective retry). */
  previousProblems?: string[];
}

export interface GenerateFollowupInput {
  profile: CandidateProfile;
  sequence: number;
  totalFollowups: number;
  recipientName: string;
  jobTitle: string;
  companyName: string;
  jobSkills: string[];
  previousEmails: Array<{ subject: string; body: string; sentAt: string }>;
  usedFacts: string[];
  previousProblems?: string[];
}

export interface AiUsage {
  inputTokens?: number;
  outputTokens?: number;
  model: string;
}

export interface AiResult<T> {
  output: T;
  usage: AiUsage;
}

/** Swappable AI provider. Implementations must never invent candidate facts. */
export interface AIProvider {
  readonly name: string;
  readonly isLlm: boolean;
  analyzeJob(input: AnalyzeJobInput): Promise<AiResult<JobAnalysis>>;
  tailorResume(input: TailorResumeInput): Promise<AiResult<TailoredBullets>>;
  generateEmail(input: GenerateEmailRequest): Promise<AiResult<EmailDraft>>;
  generateFollowup(input: GenerateFollowupInput): Promise<AiResult<EmailDraft>>;
}
