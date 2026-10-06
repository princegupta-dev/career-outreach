import {
  AIProvider,
  AiResult,
  AnalyzeJobInput,
  EmailDraft,
  GenerateEmailRequest,
  GenerateFollowupInput,
  JobAnalysis,
  TailorResumeInput,
  TailoredBullets,
} from './ai-provider.interface';
import { writeFollowupEmail, writeInitialEmail } from '../../domain/email/template-writer';
import { classifySkill } from '../../domain/matching/scorer';

const USAGE = { model: 'deterministic-template' };

/**
 * Zero-cost provider: deterministic analysis and templated writing.
 * Default when no LLM is configured; also the fallback when the LLM fails.
 */
export class TemplateProvider implements AIProvider {
  readonly name = 'template';
  readonly isLlm = false;

  async analyzeJob(input: AnalyzeJobInput): Promise<AiResult<JobAnalysis>> {
    const m = input.match;
    const missing = m.skills.filter((s) => s.level === 'missing');
    const output: JobAnalysis = {
      summary: `${input.jobTitle} at ${input.companyName}. Deterministic analysis only (no LLM configured).`,
      fitAssessment: m.reasons.join(' '),
      scoreAdjustment: 0,
      adjustmentReason: 'No semantic adjustment without an LLM.',
      recommendation: m.recommendation,
      strengths: m.strong.map((s) => `${s} — listed in your profile as a strong skill`),
      gaps: missing.map((s) => ({ skill: s.skill, severity: s.required ? 'notable' : 'minor', note: s.required ? 'Required in the JD; not in your profile.' : 'Nice to have.' })),
      talkingPoints: m.strong.slice(0, 4).map((s) => `Production experience with ${s}`),
      redFlags: m.flags,
      interviewPrep: [
        ...m.strong.slice(0, 3).map((s) => `Be ready to go deep on ${s} trade-offs you have handled in production`),
        ...m.skills.filter((s) => s.level === 'partial').slice(0, 2).map((s) => `Prepare how your ${classifySkill(s.skill, input.profile).via?.replace('related experience: ', '') ?? 'related'} experience maps to ${s.skill}`),
      ],
      companyFacts: [],
    };
    return { output, usage: USAGE };
  }

  async tailorResume(_input: TailorResumeInput): Promise<AiResult<TailoredBullets>> {
    // No rewriting without an LLM — the deterministic selection already ran.
    return { output: { rewrites: [] }, usage: USAGE };
  }

  async generateEmail(req: GenerateEmailRequest): Promise<AiResult<EmailDraft>> {
    const draft = writeInitialEmail(req.input, req.profile);
    return { output: { ...draft, provider: this.name }, usage: USAGE };
  }

  async generateFollowup(input: GenerateFollowupInput): Promise<AiResult<EmailDraft>> {
    const draft = writeFollowupEmail(input, input.profile);
    return { output: { subject: draft.subject, body: draft.body, provider: this.name, usedFact: draft.usedFact }, usage: USAGE };
  }
}
