/* eslint-disable no-console -- terminal output is this file's job */
import { runApply } from './apply/run';
import { loadSettings, SETTINGS_FILE } from './apply/settings';
import { saveRun } from './results';
import { searchJobs } from './search';

/**
 * `npm run daily` — the whole morning routine in one command:
 *   1. find new jobs: company career sites + Naukri, Hirist, Instahyre and Wellfound (your logged-in Chrome);
 *   2. save them to the dashboard;
 *   3. apply on the sites switched "on" in ~/.job-hunter/settings.json ("dry-run" sites: everything but the click).
 */
export const DAILY_SITES = ['naukri', 'hirist', 'instahyre', 'wellfound'];

async function main(): Promise<void> {
  const started = Date.now();
  const settings = loadSettings();
  console.log(`[${new Date().toLocaleString()}] Daily run: jobs from the last ${settings.days} days.`);

  const run = await searchJobs({ maxAgeDays: settings.days, sites: { keys: DAILY_SITES } });
  const store = saveRun(run);
  const newToday = Object.values(store.jobs).filter((j) => j.firstSeenAt === run.ranAt).length;
  const bySource: Record<string, number> = {};
  for (const j of run.jobs) bySource[j.source] = (bySource[j.source] ?? 0) + 1;
  console.log(`Found ${run.jobs.length} matching jobs (${newToday} new): ${Object.entries(bySource).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  for (const s of run.sources.filter((x) => x.error)) console.log(`  ! ${s.source}: ${s.error}`);
  for (const w of run.warnings) console.log(`  ! ${w}`);

  const applied = await runApply({ log: (l) => console.log(l) });
  console.log(`\nApply: ${Object.entries(applied.counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing to apply to'}`);
  if (applied.unanswered) console.log(`${applied.unanswered} questions need your answer → npm run answers`);
  console.log(`Dashboard: http://localhost:3000 · Auto-apply switches: ${SETTINGS_FILE} · ${Math.round((Date.now() - started) / 1000)}s`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
