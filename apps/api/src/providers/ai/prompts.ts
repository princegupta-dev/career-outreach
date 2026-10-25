import { profileForPrompt, CandidateProfile } from '../../domain/profile/profile';
import { firstName, GenerateEmailInput } from '../../domain/email/voice';
import { LINKEDIN_NOTE_TARGET, LinkedInNoteInput } from '../../domain/linkedin/note';
import type { MatchResult } from '../../domain/matching/scorer';

/**
 * Stable system prompt (cache-friendly: no timestamps or per-request data).
 * The candidate profile is appended as a separate stable block.
 */
export const SYSTEM_RULES = `You are the writing and analysis assistant inside Prince Gupta's personal career outreach tool.

Truthfulness rules (non-negotiable):
- Only use facts present in the CANDIDATE PROFILE or the JOB DESCRIPTION you are given.
- Never invent metrics, numbers, companies, titles, achievements, responsibilities or technologies.
- Never claim Prince has used a technology unless it is listed in his profile's strong skills.
- If the job needs something Prince lacks, call it a gap. Do not paper over it.
- Never state company facts (funding, growth, products, architecture) that are not in the provided material.
- If something is unknown, say UNKNOWN rather than guessing.

Prince's voice (for any text written as Prince):
- A senior backend engineer writing directly to another professional.
- Short paragraphs, simple English, direct, confident, warm but not overly friendly.
- Technically specific where relevant; no skill dumps.
- No buzzwords, no flattery, no desperation, no exclamation-heavy enthusiasm.
- Never use: "Hope this email finds you well", "thrilled", "I am writing to express my interest",
  "keen interest", "honored", "perfect candidate", "extensive expertise", "synergy",
  "passionate technology enthusiast", "Dear Hiring Team", "leverage", "proven track record",
  "results-driven", "cutting-edge", "delve".`;

export function profileBlock(profile: CandidateProfile): string {
  return `CANDIDATE PROFILE (canonical — the only source of facts about Prince):\n\n${profileForPrompt(profile)}`;
}

export function analyzeJobPrompt(args: { jobTitle: string; companyName: string; description: string; match: MatchResult }): string {
  const m = args.match;
  return `Analyse this job for Prince.

A deterministic matcher already scored it ${m.total}/100 (${m.recommendation}).
Component scores: ${m.components.map((c) => `${c.label} ${c.score}/${c.max} (${c.reason})`).join('; ')}
Strong matches: ${m.strong.join(', ') || 'none'}
Partial: ${m.partial.join(', ') || 'none'}
Missing (required): ${m.missing.join(', ') || 'none'}

Your job is the semantic part the matcher cannot do: what the role really involves, whether Prince's actual
experience fits it, red flags, and truthful talking points. Use scoreAdjustment (-10..+10) only when the
deterministic score is clearly off for a semantic reason, and explain why.

JOB: ${args.jobTitle} at ${args.companyName}

JOB DESCRIPTION:
"""
${args.description.slice(0, 15000)}
"""`;
}

export function tailorPrompt(args: { jobTitle: string; companyName: string; jobSkills: string[]; description: string; bullets: Array<{ id: string; text: string; roleTechnologies: string[] }>; summary?: string }): string {
  return `Rewrite some of Prince's resume bullets so they align with this job's language — without changing facts.

Rules for each rewrite:
- Keep the same facts. Rephrase and reorder words only; you may use the JD's terminology for the SAME thing.
- Do not add technologies, numbers, metrics, scope, team size or seniority words (led/owned/architected) that are not in the original.
- Keep each bullet under ~30 words.
- Only return bullets you actually improved. Skip bullets that are irrelevant to this job.
- In "id" copy the id exactly as given (like L2-0). Put the rewritten bullet only in "text" and a short reason in "reason".
${args.summary ? '- Also rewrite the SUMMARY below in "summary": same facts and years of experience, the job\'s wording, no more than its current length.\n' : ''}
JOB: ${args.jobTitle} at ${args.companyName}
JD technologies: ${args.jobSkills.join(', ')}

JD (excerpt):
"""
${args.description.slice(0, 6000)}
"""

BULLETS (id: text [role technologies]):
${args.bullets.map((b) => `${b.id}: ${b.text} [${b.roleTechnologies.join(', ')}]`).join('\n')}${args.summary ? `\n\nSUMMARY:\n${args.summary}` : ''}`;
}

const STYLE_NOTES: Record<GenerateEmailInput['style'], string> = {
  concise: 'Concise: get to the point quickly; ~90-120 words.',
  technical: 'Technical: one concrete technical overlap with a little more detail; ~110-140 words.',
  warm: 'Warm: slightly more personal opening that references the company (only verified facts); ~100-140 words.',
};

export function emailPrompt(input: GenerateEmailInput, previousProblems?: string[]): string {
  return `Write a cold email from Prince to ${input.recipientName}${input.recipientRole ? ` (${input.recipientRole})` : ''} at ${input.companyName} about the ${input.jobTitle} role.

Structure: personal opening that names the role → why this role/company (genuine reason grounded in the JD) →
Prince's relevant experience (natural sentences, mention the real overlap — do not list every skill) →
simple call to action → ${input.attachResume ? 'mention the attached resume' : 'offer to share his resume'} → sign-off "Best,\\n${'Prince Gupta'}".

Constraints:
- 80-150 words in the body (excluding greeting and sign-off). ${STYLE_NOTES[input.style]}
- Subject: plain and specific, e.g. "${input.jobTitle} — Node.js / TypeScript". No clickbait.
- Greeting: "Hi ${firstName(input.recipientName)},"
- Recipient type: ${input.recipientCategory.replace(/_/g, ' ').toLowerCase()}. Founders/CTOs: ask for a short call. Recruiters: offer to share more details. Managers: "if you're the right person to speak with".
- Overlap to highlight (Prince genuinely has these): ${input.overlapSkills.join(', ') || 'backend systems'}
- Gaps (do NOT claim; optionally acknowledge one honestly): ${input.missingSkills.join(', ') || 'none'}
- Verified company facts you may use: ${input.companyFacts.length ? input.companyFacts.map((f) => f.text).join(' | ') : 'none — do not state any company facts beyond the JD'}
${input.workMode === 'remote' ? '- The role is remote.\n' : ''}${previousProblems?.length ? `\nYour previous draft was rejected for: ${previousProblems.join('; ')}. Fix these.\n` : ''}
JOB DESCRIPTION (excerpt):
"""
${input.jobSummary.slice(0, 6000)}
"""`;
}

export function followupPrompt(args: {
  sequence: number;
  totalFollowups: number;
  recipientName: string;
  jobTitle: string;
  companyName: string;
  previousEmails: Array<{ subject: string; body: string; sentAt: string }>;
  previousProblems?: string[];
}): string {
  const kind =
    args.sequence >= args.totalFollowups && args.sequence > 1
      ? 'FINAL follow-up: a polite close-the-loop note. Make clear this is the last email. 30-60 words.'
      : args.sequence === 1
        ? 'Follow-up #1: a short, friendly reminder. 20-50 words. No new pitch.'
        : 'Follow-up #2: add ONE piece of relevant candidate context not mentioned before (from the profile only), and ask for a pointer to the right person if needed. 40-80 words.';
  return `Write follow-up email #${args.sequence} of ${args.totalFollowups} from Prince to ${args.recipientName} at ${args.companyName} about the ${args.jobTitle} role. The recipient has NOT replied.

${kind}
- It is sent as a reply in the same thread, so the subject is ignored — return an empty subject.
- Do not repeat sentences from earlier emails. Do not guilt-trip, do not say "just bumping this", do not apologise excessively.
- Greeting "Hi ${firstName(args.recipientName)}," and sign-off "Best,\\nPrince Gupta" (or "Thanks,\\nPrince Gupta").
${args.previousProblems?.length ? `\nYour previous draft was rejected for: ${args.previousProblems.join('; ')}. Fix these.\n` : ''}
EARLIER EMAILS IN THIS THREAD:
${args.previousEmails.map((e, i) => `--- Email ${i + 1} (${e.sentAt}) — ${e.subject}\n${e.body}`).join('\n\n')}`;
}

export function linkedinNotePrompt(input: LinkedInNoteInput, previousProblems?: string[]): string {
  return `Write a short LinkedIn connection-request note from Prince to ${input.recipientName ?? 'someone at the company'}${input.recipientRole ? ` (${input.recipientRole})` : ''} at ${input.companyName}. He is interested in the ${input.jobTitle} role.

Rules:
- At most ${LINKEDIN_NOTE_TARGET} characters in total, including spaces. This is a hard limit.
- Friendly and specific, like a real person. One or two short sentences about a real overlap, then a soft ask to connect.
- Greeting: "Hi ${input.recipientName ? firstName(input.recipientName) : 'there'},"
- Only mention these skills (Prince really has them): ${input.overlapSkills.slice(0, 4).join(', ') || 'backend systems'}. No other technologies.
- Verified company facts you may use: ${input.companyFacts.length ? input.companyFacts.map((f) => f.text).join(' | ') : 'none — state no facts about the company'}
- No links, no email, no phone number. Do not say he applied. Do not ask for a referral or a job.
- Use the job title exactly as written ("${input.jobTitle}") and name ${input.companyName}. No hashtags, no emoji, no exclamation marks.
- No clichés ("hope you are well", "thrilled", "keen interest").
${previousProblems?.length ? `\nYour previous note was rejected for: ${previousProblems.join('; ')}. Fix these.\n` : ''}
JOB (excerpt):
"""
${input.jobSummary.slice(0, 2500)}
"""

Return {"note": "..."} only.`;
}
