import type { CompanySize } from '@prisma/client';

/** Headcount → the size buckets the scorer's company preferences use. */
export function sizeFromTeam(teamSize?: number | null): CompanySize {
  if (!teamSize || teamSize < 1) return 'UNKNOWN';
  if (teamSize <= 50) return 'EARLY_STARTUP';
  if (teamSize <= 250) return 'GROWTH_STARTUP';
  if (teamSize <= 1000) return 'MID_MARKET';
  return 'ENTERPRISE';
}
