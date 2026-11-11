/* eslint-disable no-console -- terminal output is this file's job */
import * as fs from 'fs';
import { DEFAULT_SITE_KEYS } from './browser/sites';
import { saveRun } from './results';
import { searchJobs } from './search';

/** `npm run fetch -- [days] [--sites=a,b|default] [--snapshot]` — run a search in the terminal and write jobs.json. */
async function main(): Promise<void> {
  // npm run fetch -- 7 --sites=wellfound,hirist [--snapshot]
  const args = process.argv.slice(2);
  const days = Number(args.find((a) => /^\d+$/.test(a)) ?? 30);
  const sitesArg = args.find((a) => a.startsWith('--sites='))?.slice('--sites='.length);
  const keys = sitesArg === 'default' ? DEFAULT_SITE_KEYS : (sitesArg?.split(',').filter(Boolean) ?? []);
  const started = Date.now();
  const r = await searchJobs({ maxAgeDays: days, sites: keys.length ? { keys, snapshot: args.includes('--snapshot') } : undefined });
  fs.writeFileSync('jobs.json', JSON.stringify(r, null, 2));
  // Same shared list the dashboard reads, so terminal runs show up there too.
  const total = Object.keys(saveRun(r).jobs).length;
  for (const j of r.jobs.slice(0, 40)) {
    console.log(`${String(j.score).padStart(3)}  ${(j.postedAt ?? '').slice(0, 10).padEnd(10)}  ${j.company.slice(0, 18).padEnd(18)}  ${j.title.slice(0, 55).padEnd(55)}  ${j.url ?? ''}`);
  }
  const failed = r.sources.filter((s) => s.error);
  console.log(`\n${r.jobs.length} jobs from ${r.sources.length} sources in ${Math.round((Date.now() - started) / 1000)}s. ${failed.length} sources failed. This run: jobs.json`);
  console.log(`Dashboard now has ${total} jobs in total (refresh http://localhost:3000).`);
  for (const s of failed) console.log(`  failed: ${s.source}: ${s.error}`);
  for (const w of r.warnings) console.log(`  warning: ${w}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
