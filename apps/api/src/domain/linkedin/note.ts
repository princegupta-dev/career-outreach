import { z } from 'zod';
import { findSkills } from '../skills/taxonomy';
import { BANNED_PHRASES, firstName } from '../email/voice';

/** LinkedIn cuts connection-request notes at 300 characters (200 on some free accounts, so we aim a little under). */
export const LINKEDIN_NOTE_LIMIT = 300;
export const LINKEDIN_NOTE_TARGET = 280;

export const linkedinNoteInputSchema = z.object({
  jobTitle: z.string().trim().min(2).max(200),
  companyName: z.string().trim().min(1).max(200),
  recipientName: z.string().trim().max(120).nullish(),
  recipientRole: z.string().trim().max(160).nullish(),
  overlapSkills: z.array(z.string().max(60)).max(80),
  companyFacts: z.array(z.object({ text: z.string().max(400) })).max(10),
  jobSummary: z.string().max(20000),
});
export type LinkedInNoteInput = z.infer<typeof linkedinNoteInputSchema>;

export const linkedinNoteSchema = z.object({ note: z.string() });

const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** Deterministic note: only the person's real overlapping skills, no company claims. Always fits the limit. */
export function buildTemplateNote(input: LinkedInNoteInput, senderName: string): string {
  const me = firstName(senderName);
  const hi = input.recipientName ? `Hi ${firstName(input.recipientName)},` : 'Hi,';
  const skills = list(input.overlapSkills.slice(0, 3));
  const tries = [
    `${hi} I'm ${me}, a backend engineer${skills ? ` working with ${skills}` : ''}. I came across the ${input.jobTitle} role at ${input.companyName} and it looks like a close match for my experience. I'd love to connect and learn more about the team.`,
    `${hi} I'm ${me}, a backend engineer${skills ? ` (${skills})` : ''}. The ${input.jobTitle} role at ${input.companyName} looks like a good fit. I'd love to connect.`,
    `${hi} I'm ${me}, a backend engineer interested in the ${input.jobTitle} role at ${input.companyName}. I'd love to connect.`,
  ];
  return tries.find((t) => t.length <= LINKEDIN_NOTE_TARGET) ?? tries[tries.length - 1].slice(0, LINKEDIN_NOTE_LIMIT);
}

export interface NoteCheck {
  ok: boolean;
  problems: string[];
}

/** A note is only used when it fits, claims no skill the person does not have, and has no links or contact details. */
/** `context` is text the note may repeat as is (the job title and company name: "Acme Payments" is not a skill claim). */
export function checkLinkedInNote(note: string, allowedSkills: string[], context = '', companyName = ''): NoteCheck {
  const problems: string[] = [];
  const text = note.trim();
  if (!text) return { ok: false, problems: ['Empty note'] };
  if (text.length > LINKEDIN_NOTE_LIMIT) problems.push(`Too long (${text.length} characters, limit ${LINKEDIN_NOTE_LIMIT})`);
  if (/https?:\/\/|www\.|\S+@\S+\.\S+/i.test(text)) problems.push('Contains a link or email address');
  if (/#\w/.test(text) || /\p{Extended_Pictographic}/u.test(text)) problems.push('Contains a hashtag or emoji');
  if (companyName && !text.toLowerCase().includes(companyName.toLowerCase())) problems.push(`Does not name the company (${companyName})`);
  if (/\+?\d[\d\s().-]{8,}\d/.test(text)) problems.push('Contains a phone number');
  const allowed = new Set([...allowedSkills, ...findSkills(context).keys()]);
  const extra = [...findSkills(text).keys()].filter((s) => !allowed.has(s));
  if (extra.length) problems.push(`Mentions skills not confirmed in your profile: ${extra.join(', ')}`);
  for (const [re, label] of BANNED_PHRASES) if (re.test(text)) problems.push(`Uses banned phrase: "${label}"`);
  if (/\b(i applied|i have applied|please (refer|hire)|refer me)\b/i.test(text)) problems.push('Asks for a referral or says you applied');
  return { ok: problems.length === 0, problems };
}
