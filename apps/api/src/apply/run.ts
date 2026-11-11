import { loadProfile } from '../search';
import { openBrowser } from '../browser/runner';
import { listJobs, loadStore } from '../results';
import { loadAnswers, unansweredQuestions } from './answers';
import { APPLY_SITES, applyOnSite, ApplySite, SITE_FOR_SOURCE } from './engine';
import { loadLog, record } from './log';
import { selectJobs } from './select';
import { loadSettings, Mode } from './settings';

export interface ApplySummary {
  counts: Record<string, number>;
  lines: string[];
  unanswered: number;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Apply on every site whose mode is "on" (or "dry-run": everything but the click), from the dashboard's job list.
 * `forceDryRun` makes every site a dry run for this call.
 */
export async function runApply(opts: { forceDryRun?: boolean; minScore?: number; max?: number; log?: (line: string) => void } = {}): Promise<ApplySummary> {
  const say = opts.log ?? (() => undefined);
  const settings = loadSettings();
  const profile = loadProfile();
  const answers = loadAnswers(profile);
  const modeOf = (k: ApplySite['key']): Mode => (opts.forceDryRun && settings.autoApply[k] !== 'off' ? 'dry-run' : settings.autoApply[k]);
  const sites = (Object.keys(APPLY_SITES) as ApplySite['key'][]).filter((k) => modeOf(k) !== 'off');
  const { jobs, left } = selectJobs(listJobs(loadStore()), loadLog(), { minScore: opts.minScore ?? settings.minScore, max: opts.max ?? settings.maxPerRun, sites });
  const counts: Record<string, number> = {};
  const lines: string[] = [];
  say(`Apply: ${jobs.length} jobs selected on ${sites.map((k) => `${APPLY_SITES[k].name} (${modeOf(k)})`).join(', ') || 'no site'}; ${left} applications left today.`);
  if (jobs.length) {
    const ctx = await openBrowser(false); // visible: you can watch every step
    const page = await ctx.newPage();
    try {
      for (const [i, job] of jobs.entries()) {
        const site = APPLY_SITES[SITE_FOR_SOURCE[job.source]];
        const dryRun = modeOf(site.key) === 'dry-run';
        let result;
        try {
          result = await applyOnSite(page, site, { id: job.id, url: job.url!, title: job.title }, { answers, strongSkills: profile.strongSkills, dryRun });
        } catch (e) {
          result = { status: 'failed' as const, note: (e as Error).message.split('\n')[0].slice(0, 200) };
        }
        record({ jobId: job.id, url: job.url!, title: job.title, company: job.company, status: result.status, at: new Date().toISOString(), note: result.note });
        counts[result.status] = (counts[result.status] ?? 0) + 1;
        const line = `${String(i + 1).padStart(2)}. ${result.status.padEnd(15)} ${job.score}  ${site.name}: ${job.company} — ${job.title}${result.note ? `  (${result.note})` : ''}`;
        lines.push(line);
        say(line);
        if (result.status === 'failed' && /Not logged in/.test(result.note ?? '')) continue;
        if (i < jobs.length - 1) await pause(dryRun ? 4000 : 20_000 + Math.random() * 20_000);
      }
    } finally {
      await ctx.close();
    }
  }
  return { counts, lines, unanswered: unansweredQuestions(loadAnswers(profile), profile.strongSkills).length };
}

export { SITE_FOR_SOURCE };
