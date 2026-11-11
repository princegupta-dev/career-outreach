/* eslint-disable no-console -- terminal output is this file's job */
import * as http from 'http';
import { listJobs, loadStore, saveRun } from './results';
import { searchJobs } from './search';

/**
 * The whole API:
 *   GET /api/jobs         every job found so far (terminal and dashboard runs), from the shared results file.
 *   GET /api/jobs/search  run a search now, save it into the shared file, return the run.
 * Applied/skipped marks live in the browser's localStorage.
 */
const PORT = Number(process.env.API_PORT ?? 4000);

export function createServer(deps: { search?: typeof searchJobs; save?: typeof saveRun; load?: typeof loadStore } = {}): http.Server {
  const { search = searchJobs, save = saveRun, load = loadStore } = deps;
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && url.pathname === '/api/health') return send(200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      const store = load();
      return send(200, { updatedAt: store.updatedAt, jobs: listJobs(store) });
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
