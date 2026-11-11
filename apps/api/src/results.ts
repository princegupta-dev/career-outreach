import * as fs from 'fs';
import * as path from 'path';
import type { FoundJob, SearchResult } from './search';

/**
 * One shared list of every job found, from the terminal (`npm run fetch`) and from the dashboard alike,
 * so the dashboard shows everything in one place. A plain JSON file: no database.
 * Applied/skipped marks stay in the browser (localStorage); this file only holds what was found.
 */
export const RESULTS_FILE = process.env.JOB_HUNTER_RESULTS_FILE ?? path.resolve(__dirname, '../.cache/results.json');
const KEEP_DAYS = 45;

export interface StoredFoundJob extends FoundJob {
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ResultsStore {
  updatedAt: string | null;
  jobs: Record<string, StoredFoundJob>;
}

export const EMPTY_STORE: ResultsStore = { updatedAt: null, jobs: {} };

/** Add one run. A job seen before keeps its first-seen time and gets fresh details. Jobs first seen over 45 days ago are dropped. */
export function mergeRun(store: ResultsStore, run: Pick<SearchResult, 'jobs' | 'ranAt'>): ResultsStore {
  const jobs: Record<string, StoredFoundJob> = {};
  const cutoff = Date.parse(run.ranAt) - KEEP_DAYS * 86_400_000;
  for (const [id, j] of Object.entries(store.jobs)) if (Date.parse(j.firstSeenAt) >= cutoff) jobs[id] = j;
  for (const j of run.jobs) jobs[j.id] = { ...j, firstSeenAt: jobs[j.id]?.firstSeenAt ?? run.ranAt, lastSeenAt: run.ranAt };
  return { updatedAt: run.ranAt, jobs };
}

/** Newest posting first, then best score. */
export function listJobs(store: ResultsStore): StoredFoundJob[] {
  return Object.values(store.jobs).sort((a, b) => (b.postedAt ?? b.firstSeenAt).localeCompare(a.postedAt ?? a.firstSeenAt) || b.score - a.score);
}

export function loadStore(file = RESULTS_FILE): ResultsStore {
  try {
    return { ...EMPTY_STORE, ...(JSON.parse(fs.readFileSync(file, 'utf8')) as ResultsStore) };
  } catch {
    return EMPTY_STORE;
  }
}

/** Write via a temp file + rename, so a crash mid-write never leaves a half-written file. */
export function saveRun(run: Pick<SearchResult, 'jobs' | 'ranAt'>, file = RESULTS_FILE): ResultsStore {
  const next = mergeRun(loadStore(file), run);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next));
  fs.renameSync(tmp, file);
  return next;
}
