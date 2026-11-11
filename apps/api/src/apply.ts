/* eslint-disable no-console -- terminal output is this file's job */
import { runApply } from './apply/run';
import { SETTINGS_FILE } from './apply/settings';

/**
 * `npm run apply -- [--dry-run] [--min-score 70] [--max 15]`
 * Applies on the sites switched "on" in ~/.job-hunter/settings.json; "dry-run" sites do everything but click.
 */
function arg(name: string): number | undefined {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : undefined;
}

runApply({ forceDryRun: process.argv.includes('--dry-run'), minScore: arg('--min-score'), max: arg('--max'), log: (l) => console.log(l) })
  .then((s) => {
    console.log(`\nDone: ${Object.entries(s.counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing to do'}.`);
    if (s.unanswered) console.log(`${s.unanswered} questions need your answer: npm run answers`);
    console.log(`Per-site switch (off / dry-run / on): ${SETTINGS_FILE}`);
  })
  .catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
