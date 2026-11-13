/* eslint-disable no-console -- terminal output is this file's job */
import * as http from 'http';
import { loadInsights } from './discover/insights';
import { createDiscoverJob } from './discover/job';
import { dailyStats, loadHistory } from './discover/select';
import { listJobs, loadStore, saveRun } from './results';
import { searchJobs } from './search';

/**
 * The whole API:
 *   GET /api/jobs         every job found so far (terminal and dashboard runs), from the shared results file.
 *   GET /api/jobs/search  run a search now, save it into the shared file, return the run.
 *   GET /api/insights     skill-gap analysis from the last `npm run discover`.
 *   GET /api/stats        jobs shown per day and source by `npm run discover`.
 *   POST /api/discover    start the discover workflow in the background (same as `npm run discover`; never applies).
 *   GET /api/discover     its progress: running, log lines, result.
 * Applied/skipped marks live in the browser's localStorage.
 */
const PORT = Number(process.env.API_PORT ?? 4000);

export function createServer(
  deps: {
    search?: typeof searchJobs;
    save?: typeof saveRun;
    load?: typeof loadStore;
    history?: typeof loadHistory;
    insights?: typeof loadInsights;
    discover?: ReturnType<typeof createDiscoverJob>;
  } = {},
): http.Server {
  const { search = searchJobs, save = saveRun, load = loadStore, history = loadHistory, insights = loadInsights } = deps;
  // Loaded only when first used, so starting the server does not load the browser code.
  const discover = deps.discover ?? createDiscoverJob(async (o) => (await import('./discover/run')).runDiscover(o));
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && url.pathname === '/api/health') return send(200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      const store = load();
      const shown = history().jobs;
      // shownOn: the day the discover workflow picked this job (absent for jobs only found by other searches).
      return send(200, { updatedAt: store.updatedAt, jobs: listJobs(store).map((j) => (shown[j.id] ? { ...j, shownOn: shown[j.id].shownOn } : j)) });
    }
    if (req.method === 'GET' && url.pathname === '/api/insights') return send(200, insights());
    if (req.method === 'GET' && url.pathname === '/api/stats') return send(200, dailyStats(history()));
    if (url.pathname === '/api/discover') {
      if (req.method === 'GET') return send(200, discover.status());
      if (req.method === 'POST') {
        const days = Number(url.searchParams.get('days') ?? NaN);
        const started = discover.start({ days: Number.isFinite(days) && days > 0 && days <= 30 ? days : undefined, email: url.searchParams.get('email') === '1' });
        return send(started ? 202 : 409, started ? discover.status() : { ...discover.status(), error: 'A discover run is already in progress' });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/jobs/search') {
      const days = Number(url.searchParams.get('days') ?? 30);
      const min = Number(url.searchParams.get('minTeam') ?? 50);
      const max = Number(url.searchParams.get('maxTeam') ?? 100);
      const siteKeys = (url.searchParams.get('sites') ?? '').split(',').filter(Boolean);
      try {
        const run = await search({ maxAgeDays: Number.isFinite(days) && days > 0 ? days : 30, startups: { minTeam: min > 0 ? min : 50, maxTeam: max >= min ? max : 100 }, sites: siteKeys.length ? { keys: siteKeys } : undefined });
        save(run);
        return send(200, run);
      } catch (e) {
        return send(500, { error: (e as Error).message });
      }
    }
    send(404, { error: 'Not found' });
  });
}

if (require.main === module) {
  // Bind to localhost only: this is a personal tool, not a public service.
  createServer().listen(PORT, '127.0.0.1', () => console.log(`API listening on http://127.0.0.1:${PORT}`));
}
