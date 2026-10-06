import { z } from 'zod';

const bullet = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(600),
  /** Optional explicit skill tags; otherwise skills are detected from text. */
  skills: z.array(z.string()).optional(),
});

export const resumeDataSchema = z.object({
  basics: z.object({
    name: z.string().min(1),
    headline: z.string().default(''),
    email: z.string().default(''),
    phone: z.string().default(''),
    location: z.string().default(''),
    linkedin: z.string().default(''),
    github: z.string().default(''),
    website: z.string().default(''),
    summary: z.string().default(''),
  }),
  experience: z
    .array(
      z.object({
        id: z.string().min(1),
        company: z.string().default(''),
        title: z.string().min(1),
        location: z.string().default(''),
        startDate: z.string().default(''),
        endDate: z.string().default(''),
        current: z.boolean().default(false),
        technologies: z.array(z.string()).default([]),
        bullets: z.array(bullet).default([]),
      }),
    )
    .default([]),
  projects: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        description: z.string().default(''),
        technologies: z.array(z.string()).default([]),
        bullets: z.array(bullet).default([]),
      }),
    )
    .default([]),
  education: z
    .array(
      z.object({
        degree: z.string().default(''),
        field: z.string().default(''),
        institution: z.string().default(''),
        year: z.union([z.string(), z.number()]).nullish(),
      }),
    )
    .default([]),
  skills: z.array(z.object({ category: z.string(), items: z.array(z.string()) })).default([]),
  achievements: z.array(z.object({ id: z.string(), text: z.string() })).default([]),
  certifications: z.array(z.object({ name: z.string(), issuer: z.string().default(''), year: z.union([z.string(), z.number()]).nullish() })).default([]),
});

export type ResumeData = z.output<typeof resumeDataSchema>;
export type ResumeBullet = z.output<typeof bullet>;

export interface ResumeChange {
  section: 'summary' | 'experience' | 'projects' | 'skills' | 'bullet';
  change: string;
  reason: string;
}

export interface TailoredResumeResult {
  data: ResumeData;
  changes: ResumeChange[];
  /** JD skills not present anywhere in the resume — reported, never added. */
  gaps: string[];
}
