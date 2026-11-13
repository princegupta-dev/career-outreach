/* eslint-disable no-console -- terminal output is this file's job */
import * as path from 'path';
import { loadLog } from './apply/log';
import { runApply } from './apply/run';
import { loadSettings, SETTINGS_FILE } from './apply/settings';
import { loadMail, mailFile, sendReport } from './mail';
import { buildReport, reportsDir, writeReport } from './report';
import { listJobs, loadStore, saveRun } from './results';
import { searchJobs } from './search';

/**
 * `npm run daily` — the whole routine in one command:
 *   1. find new jobs: company career sites, LinkedIn (public search), and Naukri, Hirist, Instahyre, Wellfound
 *      (your logged-in Chrome); save them to the dashboard;
 *   2. auto-apply on the sites switched "on" in ~/.job-hunter/settings.json; any job it cannot apply to cleanly is
 *      skipped and listed in the report with the reason;
 *   3. write the Excel report and email it to you.
 * `npm run report` does only step 3, from what was already found.   Flags: --no-email
 */
export const DAILY_SITES = ['naukri', 'hirist', 'instahyre', 'wellfound'];

async function report(started: number, headline: string): Promise<void> {
  const settings = loadSettings();
  const r = buildReport(listJobs(loadStore()), loadLog(), { minScore: settings.minScore });
  const day = new Date().toISOString().slice(0, 10);
  const file = await writeReport(r, path.join(reportsDir(), `jobs-${day}.xlsx`));
  console.log(`\nReport: ${file}\n  Apply manually: ${r.manual.length} · Applied: ${r.applied.length} · All jobs: ${r.all.length}`);
  if (process.argv.includes('--no-email')) return;
  const mail = loadMail();
  if (!mail) {
    console.log(`  Not emailed: add a Gmail App Password to ${mailFile()} (see README, "Email the report").`);
    return;
  }
  const text = [
    headline,
    '',
    `Apply manually: ${r.manual.length} high-quality jobs the tool could not auto-apply to (reason in each row).`,
    `Auto-applied so far: ${r.applied.length}.`,
    '',
    ...r.manual.slice(0, 10).map((x) => `• ${x.score} ${x.title} — ${x.company} (${x.location}) ${x.link}`),
    '',
    `Full list attached. Run time ${Math.round((Date.now() - started) / 1000)}s.`,
  ].join('\n');
  const id = await sendReport({ subject: `Job Hunter: ${r.manual.length} to apply, ${r.applied.length} applied (${day})`, text, file, settings: mail });
  console.log(`  Emailed to ${mail.to}${id ? ` (${id})` : ''}`);
}

async function daily(): Promise<void> {
  const started = Date.now();
  const settings = loadSettings();
  console.log(`[${new Date().toLocaleString()}] Daily run: jobs from the last ${settings.days} days.`);

  const run = await searchJobs({ maxAgeDays: settings.days, sites: { keys: DAILY_SITES } });
  const store = saveRun(run);
  const newToday = Object.values(store.jobs).filter((j) => j.firstSeenAt === run.ranAt).length;
  const bySource: Record<string, number> = {};
  for (const j of run.jobs) bySource[j.source] = (bySource[j.source] ?? 0) + 1;
  const found = `Found ${run.jobs.length} matching jobs (${newToday} new): ${Object.entries(bySource).map(([k, v]) => `${k} ${v}`).join(', ')}`;
  console.log(found);
  for (const s of run.sources.filter((x) => x.error)) console.log(`  ! ${s.source}: ${s.error}`);
  for (const w of run.warnings) console.log(`  ! ${w}`);

  const applied = await runApply({ log: (l) => console.log(l) });
  const applyLine = `Apply: ${Object.entries(applied.counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing to apply to'}`;
  console.log(`\n${applyLine}`);
  if (applied.unanswered) console.log(`${applied.unanswered} questions need your answer → npm run answers`);

  await report(started, `${found}\n${applyLine}`);
  console.log(`Dashboard: http://localhost:3000 · Auto-apply switches: ${SETTINGS_FILE}`);
}

const main = process.argv.includes('--report-only') ? () => report(Date.now(), 'Report from the jobs already found.') : daily;
main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
