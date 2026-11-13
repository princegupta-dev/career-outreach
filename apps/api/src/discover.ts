/* eslint-disable no-console -- terminal output is this file's job */
import { runDiscover } from './discover/run';

/**
 * `npm run discover [-- --days 3] [--email] [--snapshot]` — see discover/run.ts. Never applies.
 * The dashboard's "Discover today's jobs" button runs the same function.
 */
function arg(name: string): number | undefined {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : undefined;
}

runDiscover({ days: arg('--days'), email: process.argv.includes('--email'), snapshot: process.argv.includes('--snapshot'), log: (l) => console.log(l) }).catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
