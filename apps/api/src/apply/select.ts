import type { StoredFoundJob } from '../results';
import type { ApplySite } from './engine';
import { SITE_FOR_SOURCE } from './engine';
import { appliedToday, ApplyLog, isDone } from './log';

/** Hard ceiling per day across all sites, whatever settings or the command line say. */
export const DAILY_LIMIT = 30;

export interface SelectOptions {
  minScore: number;
  max: number;
  /** Sites to apply on (from the dashboard job's source). */
  sites: ApplySite['key'][];
  now?: Date;
}

/** Jobs worth applying to, best first: on an enabled site, above the score, never tried before, within today's limit. */
export function selectJobs(jobs: StoredFoundJob[], log: ApplyLog, o: SelectOptions): { jobs: StoredFoundJob[]; left: number } {
  const left = Math.max(0, DAILY_LIMIT - appliedToday(log, o.now));
  const picked = jobs
    .filter((j) => o.sites.includes(SITE_FOR_SOURCE[j.source]) && !!j.url && j.score >= o.minScore && j.recommendation !== 'SKIP' && !isDone(log, j.id))
    // The site says Apply opens the employer's own website: nothing to auto-apply there.
    .filter((j) => !j.flags.includes('apply:company-site'))
    .sort((a, b) => b.score - a.score || (b.postedAt ?? '').localeCompare(a.postedAt ?? ''))
    .slice(0, Math.min(o.max, left));
  return { jobs: picked, left };
}
