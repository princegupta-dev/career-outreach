import { z } from 'zod';
import { findSkills } from '../skills/taxonomy';

/** Phrases that make an email sound generic, desperate or AI-written. */
export const BANNED_PHRASES: Array<[RegExp, string]> = [
  [/hope (this|my) (email|message|note) finds you well/i, 'Hope this email finds you well'],
  [/i hope you('re| are) (doing )?well/i, 'I hope you are well'],
  [/thrilled to/i, 'thrilled to'],
  [/(writing|reaching out) to express my (keen |strong )?interest/i, 'writing to express my interest'],
  [/\bkeen interest\b/i, 'keen interest'],
  [/would be (honou?red|delighted)/i, 'would be honored'],
  [/perfect (candidate|fit)/i, 'perfect candidate'],
  [/extensive (expertise|experience)/i, 'extensive expertise'],
  [/\bsynerg(y|ies|ize)\b/i, 'synergy'],
  [/passionate (technology )?enthusiast/i, 'passionate technology enthusiast'],
  [/dear hiring (team|manager)/i, 'Dear Hiring Team'],
  [/to whom it may concern/i, 'To whom it may concern'],
  [/\b(rockstar|ninja|guru)\b/i, 'rockstar/ninja'],
  [/\bleverag(e|ing) my\b/i, 'leverage my'],
  [/\bproven track record\b/i, 'proven track record'],
  [/\bresults-driven\b/i, 'results-driven'],
  [/\bdynamic (team|environment)\b/i, 'dynamic team'],
  [/\bcutting[- ]edge\b/i, 'cutting-edge'],
  [/\bi am confident that i\b/i, 'I am confident that I'],
  [/\bdelve\b/i, 'delve'],
  [/\btapestry\b/i, 'tapestry'],
  [/\bin today'?s fast-paced\b/i, "in today's fast-paced"],
  [/\bgame[- ]changer\b/i, 'game-changer'],
  [/\bunparalleled\b/i, 'unparalleled'],
  [/\bpassionate\b|\bpassion for\b/i, 'passionate'],
  [/\bdream (job|opportunity|role|company)\b/i, 'dream opportunity'],
  [/\bexcited to (apply|share|reach out)\b/i, 'excited to apply'],
  [/\bi am writing to\b/i, 'I am writing to'],
];

export interface EmailDraftLike {
  subject: string;
  body: string;
}

export interface VoiceCheck {
  ok: boolean;
  wordCount: number;
  problems: string[];
  warnings: string[];
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

/** Body without greeting/sign-off lines, for length checks. */
function coreBody(body: string): string {
  const lines = body.trim().split('\n');
  const start = /^(hi|hello|hey)\b/i.test(lines[0] ?? '') ? 1 : 0;
  let end = lines.length;
  const signoffIdx = lines.findIndex((l, i) => i > 0 && /^(best|thanks|thank you|regards|cheers|best regards|kind regards)[,!.]?\s*$/i.test(l.trim()));
  if (signoffIdx > 0) end = signoffIdx;
  return lines.slice(start, end).join('\n');
}

export interface VoiceRules {
  minWords: number;
  maxWords: number;
  /** Skills the candidate genuinely has (canonical names). */
  candidateSkills: string[];
  /** Skills mentioned in the JD (allowed when describing the role). */
  jobSkills: string[];
}

/**
 * Validates a generated email against Prince's voice + truthfulness rules.
 * `problems` are hard failures; `warnings` are shown to the user for review.
 */
export function checkVoice(draft: EmailDraftLike, rules: VoiceRules): VoiceCheck {
  const problems: string[] = [];
  const warnings: string[] = [];
  const text = `${draft.subject}\n${draft.body}`;
  for (const [re, label] of BANNED_PHRASES) if (re.test(text)) problems.push(`Uses banned phrase: "${label}"`);

  const wordCount = countWords(coreBody(draft.body));
  if (wordCount < rules.minWords) problems.push(`Too short (${wordCount} words, minimum ${rules.minWords})`);
  if (wordCount > rules.maxWords) problems.push(`Too long (${wordCount} words, maximum ${rules.maxWords})`);

  if (!draft.subject.trim()) problems.push('Missing subject');
  if (draft.subject.length > 90) problems.push('Subject is too long');
  if (/!{2,}|\b(urgent|asap|act now)\b/i.test(draft.subject)) problems.push('Subject looks like clickbait');
  if ((draft.body.match(/!/g) ?? []).length > 1) warnings.push('More than one exclamation mark');
  if (/\[(name|company|role|.*?)\]|\{\{.*?\}\}/i.test(draft.body)) problems.push('Contains an unfilled placeholder');

  const mentioned = [...findSkills(draft.body).keys()];
  const unknown = mentioned.filter((s) => !rules.candidateSkills.includes(s) && !rules.jobSkills.includes(s));
  if (unknown.length) problems.push(`Mentions technologies not in your profile or the JD: ${unknown.join(', ')}`);
  const jdOnly = mentioned.filter((s) => !rules.candidateSkills.includes(s) && rules.jobSkills.includes(s));
  if (jdOnly.length) warnings.push(`Mentions ${jdOnly.join(', ')} (from the JD, not in your profile) — make sure it is not claimed as your experience`);

  // Metrics must not appear unless they exist in the profile (we have none) — flag any numbers with %/x/users.
  if (/\b\d+(\.\d+)?\s?(%|x\b|k\+? users|million|requests\/s|rps|qps)/i.test(draft.body)) problems.push('Contains a metric — metrics must come from your profile');

  return { ok: problems.length === 0, wordCount, problems, warnings };
}

/** Input validation for email generation requests. */
export const generateEmailInputSchema = z.object({
  jobTitle: z.string().trim().min(2).max(200),
  companyName: z.string().trim().min(1).max(200),
  recipientName: z.string().trim().min(1).max(120),
  recipientRole: z.string().trim().max(160).nullish(),
  recipientCategory: z.string().max(40),
  jobSkills: z.array(z.string().max(60)).max(80),
  overlapSkills: z.array(z.string().max(60)).max(80),
  missingSkills: z.array(z.string().max(60)).max(80),
  companyFacts: z.array(z.object({ text: z.string().max(400), sourceUrl: z.string().max(500).nullish() })).max(10),
  jobSummary: z.string().max(20000),
  style: z.enum(['concise', 'technical', 'warm']),
  attachResume: z.boolean(),
  workMode: z.string().max(20).optional(),
  variantSeed: z.string().max(100).optional(),
});

export type GenerateEmailInput = z.infer<typeof generateEmailInputSchema>;

export function firstName(fullName: string): string {
  const cleaned = fullName.trim().replace(/^(mr|ms|mrs|dr)\.?\s+/i, '');
  // Shared inboxes ("Acme hiring team") are greeted as a team, never by a guessed name.
  if (/\bteam\b/i.test(cleaned)) return cleaned.replace(/\bhiring team\b/i, 'team');
  return cleaned.split(/\s+/)[0] || cleaned;
}
