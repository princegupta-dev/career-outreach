import { z } from 'zod';
import YAML from 'yaml';
import { canonicalizeSkill, findSkills } from '../skills/taxonomy';

const str = z.string().nullish().transform((v) => v ?? '');
const strList = z
  .array(z.string().nullish())
  .nullish()
  .transform((v) => (v ?? []).filter((s): s is string => !!s && s.trim().length > 0).map((s) => s.trim()));

export const COMPANY_PREFERENCES = [
  'early_stage_startup',
  'growth_stage_startup',
  'mid_market',
  'enterprise',
  'international_startup',
  'remote_first',
] as const;

export const profileSchema = z.object({
  name: z.string().min(1),
  headline: str,
  current_title: str,
  current_company: str,
  location: str,
  contact: z
    .object({ email: str, phone: str, linkedin: str, github: str, website: str })
    .partial()
    .nullish()
    .transform((c) => ({
      email: c?.email ?? '',
      phone: c?.phone ?? '',
      linkedin: c?.linkedin ?? '',
      github: c?.github ?? '',
      website: c?.website ?? '',
    })),
  education: z
    .array(
      z.object({
        degree: str,
        field: str,
        institution: str,
        graduation_year: z.coerce.number().int().nullish(),
      }),
    )
    .nullish()
    .transform((v) => v ?? []),
  career_start_year: z.coerce.number().int().min(1980).max(2100).nullish(),
  target_roles: strList,
  target_locations: strList,
  open_to_international: z.boolean().nullish().transform((v) => v ?? true),
  open_to_relocation: z.boolean().nullish().transform((v) => v ?? false),
  compensation: z
    .object({
      india_min_lpa: z.coerce.number().nullish(),
      india_max_lpa: z.coerce.number().nullish(),
      international_note: str,
    })
    .nullish()
    .transform((c) => ({
      india_min_lpa: c?.india_min_lpa ?? null,
      india_max_lpa: c?.india_max_lpa ?? null,
      international_note: c?.international_note ?? '',
    })),
  company_preferences: strList,
  avoid_companies: strList,
  skills: z
    .object({ strong: strList, partial: strList, learning: strList })
    .partial()
    .nullish()
    .transform((s) => ({ strong: s?.strong ?? [], partial: s?.partial ?? [], learning: s?.learning ?? [] })),
  domains: strList,
  projects: z
    .array(z.object({ name: z.string(), description: str, technologies: strList }))
    .nullish()
    .transform((v) => v ?? []),
});

export type ProfileData = z.output<typeof profileSchema>;

export interface CandidateProfile extends ProfileData {
  /** Canonical taxonomy names. */
  strongSkills: string[];
  partialSkills: string[];
  learningSkills: string[];
  /** Canonical taxonomy names for profile domains (e.g. "E-commerce systems" → "E-commerce"). */
  domainSkills: string[];
  experienceYears: number;
  /** Markdown body (narrative, used verbatim in AI prompts). */
  body: string;
}

const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

export class ProfileParseError extends Error {}

export function parseProfileMarkdown(markdown: string, now: Date = new Date()): CandidateProfile {
  const match = FRONTMATTER.exec(markdown.replace(/^\uFEFF/, ''));
  if (!match) throw new ProfileParseError('Profile must start with a YAML frontmatter block (--- ... ---).');
  let raw: unknown;
  try {
    raw = YAML.parse(match[1]);
  } catch (e) {
    throw new ProfileParseError(`Invalid YAML frontmatter: ${(e as Error).message}`);
  }
  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProfileParseError(
      `Invalid profile: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const data = parsed.data;
  const gradYear = data.education.map((e) => e.graduation_year).find((y): y is number => typeof y === 'number');
  const startYear = data.career_start_year ?? gradYear ?? now.getFullYear();
  const uniq = (xs: string[]) => [...new Set(xs.map(canonicalizeSkill))];
  const strongSkills = uniq(data.skills.strong);
  const partialSkills = uniq(data.skills.partial).filter((s) => !strongSkills.includes(s));
  const learningSkills = uniq(data.skills.learning).filter((s) => !strongSkills.includes(s) && !partialSkills.includes(s));
  const domainSkills = [...new Set(data.domains.flatMap((d) => [...findSkills(d).keys()]))];
  return {
    ...data,
    domainSkills,
    strongSkills,
    partialSkills,
    learningSkills,
    experienceYears: Math.max(0, now.getFullYear() - startYear),
    body: match[2].trim(),
  };
}

/** Compact text version of the profile for LLM prompts (stable ordering → cache friendly). */
export function profileForPrompt(p: CandidateProfile): string {
  const lines = [
    `Name: ${p.name}`,
    `Current title: ${p.current_title || 'UNKNOWN'}`,
    `Current company: ${p.current_company || 'UNKNOWN (do not mention a company name)'}`,
    `Location: ${p.location || 'UNKNOWN'}`,
    `Professional experience: ~${p.experienceYears} years (career start ${p.career_start_year ?? 'from graduation'})`,
    `Education: ${p.education.map((e) => `${e.degree} ${e.field} ${e.graduation_year ?? ''}`.trim()).join('; ') || 'UNKNOWN'}`,
    `Target roles: ${p.target_roles.join(', ')}`,
    `Strong skills (used professionally): ${p.strongSkills.join(', ')}`,
    `Partial skills: ${p.partialSkills.join(', ') || 'none listed'}`,
    `Learning: ${p.learningSkills.join(', ') || 'none listed'}`,
    `Domains: ${p.domains.join(', ')}`,
    `Projects: ${p.projects.map((pr) => (pr.description ? `${pr.name} (${pr.description})` : pr.name)).join('; ')}`,
    '',
    p.body,
  ];
  return lines.join('\n');
}
