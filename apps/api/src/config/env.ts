import { z } from 'zod';
import * as path from 'path';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  APP_URL: z.string().url().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379/0'),

  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex chars (32 bytes)'),
  ALLOW_REGISTRATION: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  CANDIDATE_PROFILE_PATH: z.string().default('../../candidate/candidate-profile.md'),

  AI_PROVIDER: z.enum(['anthropic', 'template']).default('template'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5-5'),
  ANTHROPIC_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),
  AI_MIN_SCORE_FOR_ANALYSIS: z.coerce.number().int().min(0).max(100).default(65),

  EMAIL_PROVIDER: z.enum(['gmail', 'sandbox']).default('sandbox'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),

  HUNTER_API_KEY: z.string().optional(),

  EMAIL_SYNC_CRON: z.string().default('*/10 * * * *'),
  FOLLOWUP_CRON: z.string().default('*/15 * * * *'),
  DISCOVERY_CRON: z.string().default('30 1 * * *'),
  ANALYTICS_CRON: z.string().default('0 * * * *'),
});

export type Env = z.infer<typeof schema> & { candidateProfilePath: string };

let cached: Env | null = null;

/** Validates process.env once. Fails fast with a readable message (never prints secret values). */
function loadDotEnv(): void {
  // Local dev convenience. In Docker, variables come from the environment instead.
  for (const file of ['.env', '../../.env']) {
    try {
      (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile?.(file);
      return;
    } catch {
      /* file not present */
    }
  }
}

export function loadEnv(): Env {
  if (cached) return cached;
  if (process.env.NODE_ENV !== 'test') loadDotEnv();
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  const candidateProfilePath = path.isAbsolute(env.CANDIDATE_PROFILE_PATH)
    ? env.CANDIDATE_PROFILE_PATH
    : path.resolve(process.cwd(), env.CANDIDATE_PROFILE_PATH);
  cached = { ...env, candidateProfilePath };
  return cached;
}

/** Test helper: forget the cached env so a test can change process.env. */
export function resetEnvCache(): void {
  cached = null;
}

export const ENV = Symbol('ENV');
