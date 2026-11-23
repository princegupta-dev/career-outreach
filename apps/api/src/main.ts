/* eslint-disable no-console -- terminal output is this file's job */
import * as http from 'http';
import { loadInsights } from './discover/insights';
import { createDiscoverJob } from './discover/job';
import { dailyStats, loadHistory } from './discover/select';
import { listJobs, loadStore, saveRun } from './results';
import { searchJobs } from './search';
import { ollamaStatus, OutreachError } from './outreach/ollama';
import { createOutreachService } from './outreach/prepare';
import { createApplicationReview } from './apply/review';
import { readAnswerBook, removeConfirmedAnswer, saveConfirmedAnswer } from './apply/form-answers';
import { createModelManager } from './outreach/models';
import { z } from 'zod';
import { createNaukriRunner, saveNaukriResume } from './apply/naukri-run';
import { loadLog } from './apply/log';
import { PLATFORM_NAMES, type ApplicationPlatform } from './apply/platforms';

/**
 * The whole API:
 *   GET /api/jobs         every job found so far (terminal and dashboard runs), from the shared results file.
 *   GET /api/jobs/search  run a search now, save it into the shared file, return the run.
 *   GET /api/insights     skill-gap analysis from the last `npm run discover`.
 *   GET /api/stats        jobs shown per day and source by `npm run discover`.
 *   POST /api/discover    start the discover workflow in the background (same as `npm run discover`; never applies).
 *   GET /api/discover     its progress: running, log lines, result.
 *   GET /api/ollama       local outreach model availability.
 *   POST /api/outreach?jobId=...  prepare a saved job's outreach; never sends or applies.
 *   /api/application/*   open, fill and review a form; manage confirmed answers and login windows.
 *   /api/ollama/models|pull  select installed models and manage local downloads.
 * Applied/skipped marks live in the browser's localStorage.
 */
const PORT = Number(process.env.API_PORT ?? 4000);

async function jsonBody(req: http.IncomingMessage, maxBytes = 32768): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > maxBytes) throw new OutreachError('Request is too large.', 413);
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new OutreachError('Send a valid JSON request.', 400); }
}

export function createServer(
  deps: {
    search?: typeof searchJobs;
    save?: typeof saveRun;
    load?: typeof loadStore;
    history?: typeof loadHistory;
    insights?: typeof loadInsights;
    discover?: ReturnType<typeof createDiscoverJob>;
    outreach?: ReturnType<typeof createOutreachService>;
    ollama?: typeof ollamaStatus;
    application?: ReturnType<typeof createApplicationReview>;
    models?: ReturnType<typeof createModelManager>;
    naukri?: ReturnType<typeof createNaukriRunner>;
    applicationLog?: typeof loadLog;
    platforms?: Partial<Record<Exclude<ApplicationPlatform, 'naukri'>, ReturnType<typeof createNaukriRunner>>>;
  } = {},
): http.Server {
  const { search = searchJobs, save = saveRun, load = loadStore, history = loadHistory, insights = loadInsights } = deps;
  // Loaded only when first used, so starting the server does not load the browser code.
  const discover = deps.discover ?? createDiscoverJob(async (o) => (await import('./discover/run')).runDiscover(o));
  const outreach = deps.outreach ?? createOutreachService();
  const application = deps.application ?? createApplicationReview();
  const models = deps.models ?? createModelManager();
  const naukri = deps.naukri ?? createNaukriRunner();
  const runners = { naukri, hirist: deps.platforms?.hirist ?? createNaukriRunner({ platform: 'hirist' }), instahyre: deps.platforms?.instahyre ?? createNaukriRunner({ platform: 'instahyre' }), linkedin: deps.platforms?.linkedin ?? createNaukriRunner({ platform: 'linkedin' }), wellfound: deps.platforms?.wellfound ?? createNaukriRunner({ platform: 'wellfound' }), external: deps.platforms?.external ?? createNaukriRunner({ platform: 'external' }) };
  const autoBusy = () => Object.values(runners).some((runner) => runner.status().running);
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && url.pathname === '/api/health') return send(200, { ok: true });
    const platformPath = url.pathname.match(/^\/api\/(naukri|hirist|instahyre|linkedin|wellfound|external)(?:\/|$)/);
    if (platformPath) {
      const platform = platformPath[1] as ApplicationPlatform;
      const runner = runners[platform];
      const action = url.pathname.slice(`/api/${platform}`.length);
      const otherBusy = () => Object.entries(runners).some(([key, r]) => key !== platform && r.status().running);
      try {
        if (req.method !== 'GET' && req.headers['sec-fetch-site'] === 'cross-site') throw new OutreachError('Use your Job Hunter dashboard for this action.', 403);
        const optionsSchema = z.object({ minScore: z.coerce.number().min(0).max(100), max: z.coerce.number().int().min(1).max(30), days: z.coerce.number().int().min(1).max(30) });
        if (req.method === 'GET' && action === '/status') return send(200, runner.status());
        if (req.method === 'GET' && action === '/preview') {
          const values = Object.fromEntries(['minScore', 'max', 'days'].filter((key) => url.searchParams.has(key)).map((key) => [key, url.searchParams.get(key)]));
          return send(200, runner.preview(optionsSchema.partial().parse(values)));
        }
        if (req.method === 'POST' && action === '/settings') {
          const body = optionsSchema.extend({ mode: z.enum(['off', 'dry-run', 'on']) }).strict().parse(await jsonBody(req));
          if (autoBusy()) throw new OutreachError('Wait for application runs to finish before changing shared rules.', 409);
          return send(200, runner.settings(body.mode, body));
        }
        if (req.method === 'POST' && action === '/start') {
          const body = optionsSchema.extend({ mode: z.enum(['dry-run', 'apply']), token: z.string().min(1).max(100) }).strict().parse(await jsonBody(req));
          if (application.status().running || discover.status().running || otherBusy()) throw new OutreachError(`Close other Chrome sessions and wait for discovery or application runs before starting ${PLATFORM_NAMES[platform]}.`, 409);
          return send(202, runner.start(body.mode, body.token, body));
        }
        if (req.method === 'POST' && action === '/find') {
          const body = z.object({ days: z.coerce.number().int().min(1).max(30) }).strict().parse(await jsonBody(req));
          if (application.status().running || discover.status().running || otherBusy()) throw new OutreachError(`Close other Chrome sessions and wait for discovery or application runs before searching ${PLATFORM_NAMES[platform]}.`, 409);
          return send(202, runner.find(body.days));
        }
        if (req.method === 'POST' && action === '/stop') return send(200, await runner.stop());
        if (req.method === 'POST' && action === '/continue') {
          const body = z.object({ token: z.string().min(1).max(100), action: z.enum(['resume', 'skip']) }).strict().parse(await jsonBody(req));
          return send(200, runner.continue(body.token, body.action));
        }
        if (req.method === 'POST' && action === '/retry') {
          const body = z.object({ jobId: z.string().min(1).max(200), checkedNotApplied: z.literal(true) }).strict().parse(await jsonBody(req));
          if (autoBusy()) throw new OutreachError('Wait for application runs to finish before changing application history.', 409);
          runner.allowRetry(body.jobId); return send(200, { ok: true });
        }
        if (req.method === 'POST' && action === '/reconcile') return send(200, { corrected: runner.reconcile() });
        if (req.method === 'POST' && action === '/resume') {
          const body = z.object({ base64: z.string().max(12 * 1024 * 1024) }).strict().parse(await jsonBody(req, 12 * 1024 * 1024));
          if (autoBusy()) throw new OutreachError('Wait for application runs to finish before replacing the shared resume.', 409);
          return send(200, saveNaukriResume(body.base64));
        }
        return send(404, { error: 'Not found' });
      } catch (error) { return send(error instanceof OutreachError ? error.status : error instanceof z.ZodError ? 400 : 500, { error: error instanceof z.ZodError ? 'Check the application settings and refresh the preview.' : (error as Error).message }); }
    }
    if (url.pathname.startsWith('/api/application') || url.pathname.startsWith('/api/ollama/')) {
      try {
        if (req.method !== 'GET' && req.headers['sec-fetch-site'] === 'cross-site') throw new OutreachError('Use the Job Hunter dashboard for this action.', 403);
        if (req.method === 'GET' && url.pathname === '/api/application') return send(200, application.status());
        if (req.method === 'GET' && url.pathname === '/api/application/answers') return send(200, readAnswerBook());
        if (req.method === 'POST' && url.pathname === '/api/application/answers') {
          const body = z.object({ question: z.string().trim().min(1).max(600), answer: z.string().trim().min(1).max(6000), replaceMatch: z.array(z.string().min(1)).min(1).max(20).optional() }).strict().parse(await jsonBody(req));
          saveConfirmedAnswer(body.question, body.answer, body.replaceMatch);
          return send(200, readAnswerBook());
        }
        if (req.method === 'DELETE' && url.pathname === '/api/application/answers') {
          const body = z.object({ match: z.array(z.string().min(1)).min(1).max(20) }).strict().parse(await jsonBody(req));
          removeConfirmedAnswer(body.match);
          return send(200, readAnswerBook());
        }
        if (req.method === 'POST' && ['/api/application/open', '/api/application/login'].includes(url.pathname)) {
          if (autoBusy()) throw new OutreachError('Stop the application run before opening another Chrome session.', 409);
          if (discover.status().running) throw new OutreachError('Wait for job discovery to finish before opening another Chrome session.', 409);
          if (url.pathname.endsWith('/login')) return send(202, application.login(url.searchParams.get('site') ?? ''));
          const job = Object.values(load().jobs).find((j) => j.id === url.searchParams.get('jobId'));
          if (!job) throw new OutreachError('Choose a job from saved results first.', 404);
          return send(202, application.open(job));
        }
        if (req.method === 'POST' && url.pathname === '/api/application/fill') return send(202, application.startFill());
        if (req.method === 'POST' && url.pathname === '/api/application/resume') return send(200, await application.resume());
        if (req.method === 'POST' && url.pathname === '/api/application/close') return send(200, await application.close());
        if (req.method === 'GET' && url.pathname === '/api/ollama/models') return send(200, await models.list());
        if (req.method === 'POST' && url.pathname === '/api/ollama/models') {
          const body = z.object({ model: z.string().min(1).max(150) }).strict().parse(await jsonBody(req));
          await models.select(body.model);
          return send(200, await models.list());
        }
        if (req.method === 'GET' && url.pathname === '/api/ollama/pull') return send(200, models.status());
        if (req.method === 'POST' && url.pathname === '/api/ollama/pull') {
          const body = z.object({ model: z.string().min(1).max(150) }).strict().parse(await jsonBody(req));
          return send(202, models.pull(body.model));
        }
        if (req.method === 'POST' && url.pathname === '/api/ollama/pull/cancel') { models.cancel(); return send(200, models.status()); }
      } catch (error) {
        return send(error instanceof OutreachError ? error.status : error instanceof z.ZodError ? 400 : 500, { error: error instanceof z.ZodError ? 'Check the question, answer, or model name.' : (error as Error).message });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/ollama') return send(200, await (deps.ollama ?? ollamaStatus)());
    if (req.method === 'POST' && url.pathname === '/api/outreach') {
      if (req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Prepare outreach from your Job Hunter dashboard.' });
      const id = url.searchParams.get('jobId');
      if (!id) return send(400, { error: 'Choose a saved job first.' });
      const job = Object.values(load().jobs).find((j) => j.id === id);
      if (!job) return send(404, { error: 'This job is no longer in the saved results. Refresh jobs or run discovery again.' });
      try {
        return send(200, await outreach(job));
      } catch (error) {
        return send(error instanceof OutreachError ? error.status : 500, { error: error instanceof OutreachError ? error.message : 'Could not prepare outreach. Check that your profile and outreach cache are readable and writable.' });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      const store = load();
      const shown = history().jobs;
      const applicationLog = (deps.applicationLog ?? loadLog)();
      // shownOn: the day the discover workflow picked this job (absent for jobs only found by other searches).
      return send(200, { updatedAt: store.updatedAt, jobs: listJobs(store).map((j) => ({ ...j, ...(shown[j.id] ? { shownOn: shown[j.id].shownOn } : {}), ...(['applied', 'already-applied'].includes(applicationLog[j.id]?.status) ? { appliedAt: applicationLog[j.id].at } : {}) })) });
    }
    if (req.method === 'GET' && url.pathname === '/api/insights') return send(200, insights());
    if (req.method === 'GET' && url.pathname === '/api/stats') return send(200, dailyStats(history()));
    if (url.pathname === '/api/discover') {
      if (req.method === 'GET') return send(200, discover.status());
      if (req.method === 'POST') {
        if (application.status().running) return send(409, { error: 'Close the application Chrome session before starting discovery.' });
        if (autoBusy()) return send(409, { error: 'Stop the application run before starting discovery.' });
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
      if (siteKeys.length && application.status().running) return send(409, { error: 'Close the application Chrome session before searching job boards.' });
      if (siteKeys.length && naukri.status().running) return send(409, { error: 'Stop the application run before searching job boards.' });
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
