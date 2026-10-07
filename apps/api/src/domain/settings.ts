import { z } from 'zod';

export const SEND_MODES = ['DRY_RUN', 'DRAFT_ONLY', 'APPROVAL_REQUIRED', 'AUTO_SEND'] as const;
export type SendMode = (typeof SEND_MODES)[number];
/** Switching to AUTO_SEND must carry this exact confirmation string (UI shows it to the user). */
export const SEND_MODE_CONFIRMATION = 'I understand emails will be sent without my review';

export const settingsSchema = z.object({
  timezone: z.string().default('Asia/Kolkata'),
  outreach: z
    .object({
      /** Max emails (initial + follow-ups) per calendar day. */
      dailyLimit: z.number().int().min(1).max(100).default(15),
      /** Max NEW initial emails per day (subset of dailyLimit). */
      dailyInitialLimit: z.number().int().min(1).max(100).default(10),
      /** Don't email the same company again within N days (any contact). */
      companyCooldownDays: z.number().int().min(0).max(365).default(30),
      /** Don't start a new thread with the same person within N days. */
      recipientCooldownDays: z.number().int().min(0).max(730).default(90),
      /** Minimum minutes between two sends (spreads out traffic). */
      minMinutesBetweenSends: z.number().int().min(0).max(240).default(2),
      defaultStyle: z.enum(['concise', 'technical', 'warm']).default('concise'),
      /**
       * DRY_RUN: render + check, never hand anything to the mail provider.
       * DRAFT_ONLY: mirror drafts into the mailbox, never send.
       * APPROVAL_REQUIRED (default): send only what you approve.
       * AUTO_SEND: strong matches with a publicly listed/verified address are approved automatically.
       * AUTO_SEND is never switched on implicitly — see SEND_MODE_CONFIRMATION.
       */
      sendMode: z.enum(SEND_MODES).default('APPROVAL_REQUIRED'),
      /** Max emails (all kinds) per rolling hour. */
      hourlyLimit: z.number().int().min(1).max(30).default(4),
      /** Max emails per recipient domain per calendar day. */
      perDomainDailyLimit: z.number().int().min(1).max(10).default(2),
      /** Extra random delay (0..N seconds) added to queued sends so they don't go out in bursts. */
      maxJitterSeconds: z.number().int().min(0).max(900).default(120),
      /** AUTO_SEND only: minimum match score for an automatic initial email. */
      autoSendMinScore: z.number().int().min(50).max(100).default(80),
    })
    .default({
      dailyLimit: 15,
      dailyInitialLimit: 10,
      companyCooldownDays: 30,
      recipientCooldownDays: 90,
      minMinutesBetweenSends: 2,
      defaultStyle: 'concise',
      sendMode: 'APPROVAL_REQUIRED',
      hourlyLimit: 4,
      perDomainDailyLimit: 2,
      maxJitterSeconds: 120,
      autoSendMinScore: 80,
    }),
  followups: z
    .object({
      enabled: z.boolean().default(true),
      /** Wait (days) before each follow-up, relative to the previous email. */
      delaysDays: z.array(z.number().int().min(1).max(60)).min(0).max(5).default([4, 5, 7]),
      /** If false, follow-up drafts wait for manual approval (recommended). */
      autoSend: z.boolean().default(false),
      /** Only send between these local hours. */
      sendWindowStartHour: z.number().int().min(0).max(23).default(9),
      sendWindowEndHour: z.number().int().min(1).max(24).default(19),
      skipWeekends: z.boolean().default(true),
    })
    .default({ enabled: true, delaysDays: [4, 5, 7], autoSend: false, sendWindowStartHour: 9, sendWindowEndHour: 19, skipWeekends: true }),
  matching: z
    .object({
      /** Jobs at/above this deterministic score get AI analysis (if AI is enabled). */
      minScoreForAi: z.number().int().min(0).max(100).default(65),
      autoAnalyze: z.boolean().default(true),
      /** Jobs at/above this score are moved to QUALIFIED automatically. */
      qualifyScore: z.number().int().min(0).max(100).default(55),
    })
    .default({ minScoreForAi: 65, autoAnalyze: true, qualifyScore: 55 }),
  /** What the daily pipeline does on its own (never sends anything). */
  automation: z
    .object({
      /** Find contact + tailor resume + draft the email for the day's best jobs. */
      autoPrepare: z.boolean().default(true),
      dailyPrepareLimit: z.number().int().min(0).max(30).default(5),
      minScoreToPrepare: z.number().int().min(0).max(100).default(75),
      /** Mirror drafts into Gmail Drafts (with the tailored PDF attached). */
      createGmailDrafts: z.boolean().default(true),
    })
    .default({ autoPrepare: true, dailyPrepareLimit: 5, minScoreToPrepare: 75, createGmailDrafts: true }),
  discovery: z
    .object({
      enabled: z.boolean().default(true),
      /** Ignore postings older than this. */
      maxAgeDays: z.number().int().min(1).max(120).default(30),
    })
    .default({ enabled: true, maxAgeDays: 30 }),
});

/** Follow-up delays are stored relative to the previous email; the UI shows them as "day N" after the first email. */
export function cumulativeDays(delaysDays: number[]): number[] {
  let total = 0;
  return delaysDays.map((d) => (total += d));
}

export function relativeDays(cumulative: number[]): number[] {
  const sorted = [...cumulative].filter((n) => n > 0).sort((a, b) => a - b);
  return sorted.map((d, i) => d - (i === 0 ? 0 : sorted[i - 1])).filter((d) => d > 0);
}

export type UserSettings = z.output<typeof settingsSchema>;

export function resolveSettings(raw: unknown): UserSettings {
  const parsed = settingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : settingsSchema.parse({});
}
