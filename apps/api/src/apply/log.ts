import * as fs from 'fs';
import * as path from 'path';
import type { ApplicationPlatform } from './platforms';

/** Every application attempt, so a job is never applied to twice and the daily limit can be counted. */
export const APPLY_LOG = process.env.JOB_HUNTER_APPLY_LOG ?? path.resolve(__dirname, '../../.cache/applied.json');

export type ApplyStatus =
  | 'applied' // the site confirmed it
  | 'already-applied' // the site says you applied before
  | 'external' // "apply on company site": not done, listed for you
  | 'needs-answers' // a question had no single matching saved answer
  | 'no-button' // no apply button found (closed job, or the page changed)
  | 'failed' // something went wrong; the message says what
  | 'verification-required' // Apply may have reached the site; never retry until checked
  | 'dry-run'; // everything except the final click

export interface ApplyEntry {
  jobId: string;
  url: string;
  title: string;
  company: string;
  status: ApplyStatus;
  at: string;
  note?: string;
  answersHash?: string;
  platform?: ApplicationPlatform;
  targetUrl?: string;
}

export type ApplyLog = Record<string, ApplyEntry>;

/** Statuses that mean "do not try this job again". Failures and dry runs can be retried. */
const FINAL: ApplyStatus[] = ['applied', 'already-applied', 'external', 'needs-answers', 'verification-required'];
export const isDone = (log: ApplyLog, jobId: string) => !!log[jobId] && FINAL.includes(log[jobId].status);

/** Confirmed and potentially submitted applications since local midnight. Uncertain submissions reserve a slot. */
export function appliedToday(log: ApplyLog, now = new Date()): number {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return Object.values(log).filter((e) => ['applied', 'verification-required'].includes(e.status) && new Date(e.at) >= midnight).length;
}

export function loadLog(file = APPLY_LOG): ApplyLog {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ApplyLog;
  } catch {
    return {};
  }
}

/** Saved after every single attempt, so a crash never forgets an application that was sent. */
export function record(entry: ApplyEntry, file = APPLY_LOG): ApplyLog {
  const log = { ...loadLog(file), [entry.jobId]: entry };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(log, null, 1));
  fs.renameSync(tmp, file);
  return log;
}
