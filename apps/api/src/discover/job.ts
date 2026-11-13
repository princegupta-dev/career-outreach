import type { DiscoverOptions, DiscoverSummary } from './run';

/**
 * One discover run at a time, in the background, so the dashboard can start it and then ask for progress
 * (a run takes minutes; a single browser request that long would time out).
 */
export interface DiscoverStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  log: string[];
  result: DiscoverSummary | null;
  error: string | null;
}

const MAX_LOG = 300;

export function createDiscoverJob(run: (o: DiscoverOptions) => Promise<DiscoverSummary>) {
  let status: DiscoverStatus = { running: false, startedAt: null, finishedAt: null, log: [], result: null, error: null };
  let current: Promise<void> | null = null;
  return {
    /** Starts a run; false when one is already running (the existing one keeps going). */
    start(opts: Omit<DiscoverOptions, 'log'> = {}): boolean {
      if (status.running) return false;
      status = { running: true, startedAt: new Date().toISOString(), finishedAt: null, log: [], result: null, error: null };
      const log = (line: string) => {
        status.log.push(line);
        if (status.log.length > MAX_LOG) status.log.splice(0, status.log.length - MAX_LOG);
      };
      current = run({ ...opts, log })
        .then((result) => {
          status = { ...status, running: false, finishedAt: new Date().toISOString(), result };
        })
        .catch((e: unknown) => {
          status = { ...status, running: false, finishedAt: new Date().toISOString(), error: (e as Error).message ?? String(e) };
        });
      return true;
    },
    status(): DiscoverStatus {
      return { ...status, log: [...status.log] };
    },
    /** For tests: wait until the current run has finished. */
    async settled(): Promise<void> {
      await current;
    },
  };
}
