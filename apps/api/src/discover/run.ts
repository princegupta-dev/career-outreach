import * as path from 'path';
import { loadSettings } from '../apply/settings';
import { analyse, readResume, saveInsights } from './insights';
import { DAILY_TARGET, loadHistory, priorityOf, remember, saveHistory, selectToday } from './select';
import { loadMail, mailFile, sendReport } from '../mail';
import { reportsDir, writeDiscoverReport } from '../report';
import { listJobs, loadStore, saveRun } from '../results';
import { loadProfile, searchJobs } from '../search';

/**
 * `npm run discover [-- --days 3] [--email] [--snapshot]`
 * Manual-application workflow: find up to 50 genuinely relevant, never-seen-before jobs from LinkedIn, Naukri,
 * Instahyre, Wellfound and Hirist, show them on the dashboard, and analyse the skill gaps. It never applies.
 * (The daily workflow with company sites and auto-apply is unchanged: npm run daily.)
 */
export const DISCOVER_SITES = ['naukri', 'instahyre', 'wellfound', 'hirist'];

export interface DiscoverOptions {
  days?: number;
  email?: boolean;
  snapshot?: boolean;
  /** Where progress lines go (terminal or the dashboard's progress log). */
  log?: (line: string) => void;
}

export interface DiscoverSummary {
  picked: number;
  qualified: number;
  alreadyShown: number;
  bySource: Record<string, number>;
  report: string;
  seconds: number;
}

/** The whole discover workflow. Used by `npm run discover` and by the dashboard's "Discover today's jobs" button. */
export async function runDiscover(opts: DiscoverOptions = {}): Promise<DiscoverSummary> {
  const say = opts.log ?? (() => undefined);
  const started = Date.now();
  const settings = loadSettings();
  const profile = loadProfile();
  const days = opts.days ?? settings.days;
  const day = new Date().toISOString().slice(0, 10);
  say(`[${new Date().toLocaleString()}] Discover: LinkedIn, Naukri, Instahyre, Wellfound, Hirist — last ${days} days. No applications are sent.`);

  // 1. Search the five sources only (no company boards, no startup lists).
  const run = await searchJobs({
    maxAgeDays: days,
    sources: [{ provider: 'LINKEDIN', name: 'LinkedIn', config: {} }],
    startups: false,
    sites: { keys: DISCOVER_SITES, snapshot: opts.snapshot === true },
  });
  saveRun(run); // also on the dashboard's shared list, like every search
  for (const s of run.sources) say(`  ${s.error ? '!' : '✓'} ${s.source}: ${s.fetched} read, ${s.kept} kept${s.error ? ` — ${s.error}` : ''}`);
  for (const w of run.warnings) say(`  ! ${w}`);

  // 2. Quality gate + never-shown-before + up to 50.
  const history = loadHistory();
  const sel = selectToday(run.jobs, history, { minScore: settings.minScore, experienceYears: profile.experienceYears }, DAILY_TARGET);
  saveHistory(remember(history, sel.picked, day));
  const bySource: Record<string, number> = {};
  for (const j of sel.picked) bySource[j.source] = (bySource[j.source] ?? 0) + 1;
  say(`\nToday: ${sel.picked.length} new jobs (target ${DAILY_TARGET}; ${sel.qualified} qualified, ${sel.alreadyShown} already shown before).`);
  say(`  By source: ${Object.entries(bySource).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  say(`  Not qualified: ${Object.entries(sel.rejected).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  if (sel.picked.length < DAILY_TARGET) say(`  Fewer than ${DAILY_TARGET}: only ${sel.picked.length} new jobs genuinely qualified. Quality is not lowered to fill the list.`);
  for (const j of sel.picked.slice(0, 15)) say(`  ${j.score}  P${priorityOf(j.title)}  ${j.source.padEnd(9)} ${j.company.slice(0, 20).padEnd(20)} ${j.title.slice(0, 50)}`);

  // 3. Skill gaps over every qualified job shown so far that is still on the dashboard list.
  const shown = loadHistory().jobs;
  const qualifiedJobs = listJobs(loadStore()).filter((j) => shown[j.id]);
  const insights = analyse(qualifiedJobs, profile, readResume());
  saveInsights(insights);
  say(`\nSkill gaps (${insights.jobsAnalysed} qualified jobs):`);
  say(`  Most asked, missing: ${insights.missingSkills.slice(0, 8).map((s) => `${s.skill} ${s.percent}%`).join(', ') || '—'}`);
  say(`  You have, not on resume: ${insights.missingEvidence.slice(0, 6).map((s) => `${s.skill} ${s.percent}%`).join(', ') || '—'}`);
  say(`  Asking for more than your ${insights.experience.yours} years: ${insights.experience.percentAboveYours}% of jobs that state it`);

  // 4. Excel (and email if asked). Existing reports and email settings are reused, not changed.
  const file = await writeDiscoverReport(sel.picked, insights, path.join(reportsDir(), `discover-${day}.xlsx`));
  say(`\nReport: ${file}`);
  if (opts.email) {
    const mail = loadMail();
    if (!mail) say(`  Not emailed: no Gmail App Password in ${mailFile()}`);
    else {
      const text = [`${sel.picked.length} new jobs today (apply on the dashboard or via the links).`, '', ...sel.picked.slice(0, 15).map((j) => `• ${j.score} ${j.title} — ${j.company} (${j.source}) ${j.url ?? ''}`), '', `Top missing skills: ${insights.missingSkills.slice(0, 6).map((s) => `${s.skill} ${s.percent}%`).join(', ')}`].join('\n');
      await sendReport({ subject: `Job Hunter discover: ${sel.picked.length} new jobs (${day})`, text, file, settings: mail });
      say(`  Emailed to ${mail.to}`);
    }
  }
  say(`Dashboard: http://localhost:3000 · ${Math.round((Date.now() - started) / 1000)}s`);
  return { picked: sel.picked.length, qualified: sel.qualified, alreadyShown: sel.alreadyShown, bySource, report: file, seconds: Math.round((Date.now() - started) / 1000) };
}
