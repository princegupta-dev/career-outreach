import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import type { BrowserContext } from 'playwright';
import { openBrowser, readSite } from '../browser/runner';
import { sitesByKey } from '../browser/sites';
import { listJobs, loadStore, saveRun, type StoredFoundJob } from '../results';
import { criteriaFor, loadProfile, scoreRaw, type FoundJob } from '../search';
import { extractJob } from '../domain/skills/extract';
import { classifySkill, scoreJob } from '../domain/matching/scorer';
import { findSkills, getSkill } from '../domain/skills/taxonomy';
import { sizeFromTeam } from '../domain/company-size';
import { rejectReason, sameJobKey } from '../discover/select';
import { readResume, RESUME_TEXT_FILE } from '../discover/insights';
import { OutreachError } from '../outreach/ollama';
import { readAnswerBook, type FormAnswer } from './form-answers';
import { appliedToday, loadLog, record, type ApplyEntry } from './log';
import { loadSettings, SETTINGS_FILE } from './settings';
import { DAILY_LIMIT } from './select';
import { applyNaukri, isNaukriUrl } from './naukri';
import { reconcileNaukriConfirmations } from './naukri-confirmation';
import { applyPlatform } from './platform-engine';
import { applicationUrlKey, belongsToPlatform, boardJobId, PLATFORM_NAMES, publicHttps, type ApplicationPlatform } from './platforms';
import { searchJobs } from '../search';
import { LinkedInProvider } from '../providers/jobs/linkedin';
import { displayLocation, type HandoffAction, type HandoffState } from './handoff';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface NaukriOptions { minScore: number; max: number; days: number }
export interface NaukriRunStatus {
  running: boolean;
  mode: 'discover' | 'dry-run' | 'apply';
  stopping: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  completed: number;
  current: { id: string; title: string; company: string } | null;
  message: string;
  answers: FormAnswer[];
  results: ApplyEntry[];
  log: string[];
  error: string | null;
  handoff?: HandoffState | null;
}

const uncertain = (e: ApplyEntry) => e.status === 'verification-required' || (e.status === 'failed' && /clicked apply|no confirmation|locator\.click.*timeout/i.test(e.note ?? ''));
const fileForLog = () => process.env.JOB_HUNTER_APPLY_LOG ?? path.resolve(__dirname, '../../.cache/applied.json');
const resumeFile = () => process.env.JOB_HUNTER_APPLICATION_RESUME ?? process.env.JOB_HUNTER_NAUKRI_RESUME ?? path.resolve(__dirname, '../../.cache/naukri/resume.pdf');
export function naukriResumeInfo() {
  try { const stat = fs.statSync(resumeFile()); return { uploaded: true, name: 'Application resume.pdf', bytes: stat.size }; }
  catch { return { uploaded: false, name: null, bytes: 0 }; }
}
export function saveNaukriResume(base64: string) {
  const data = Buffer.from(base64, 'base64');
  if (!data.length || data.length > 8 * 1024 * 1024 || data.subarray(0, 5).toString() !== '%PDF-') throw new OutreachError('Choose a PDF resume no larger than 8 MB.', 400);
  const file = resumeFile(); fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, data, { mode: 0o600 }); fs.renameSync(tmp, file); } finally { fs.rmSync(tmp, { force: true }); }
  return naukriResumeInfo();
}

export function createNaukriRunner(deps: {
  load?: typeof loadStore;
  profile?: typeof loadProfile;
  book?: typeof readAnswerBook;
  settings?: typeof loadSettings;
  logFile?: string;
  open?: () => Promise<BrowserContext>;
  apply?: typeof applyNaukri;
  pause?: (signal: AbortSignal) => Promise<void>;
  now?: () => Date;
  collect?: (browser: BrowserContext, profile: ReturnType<typeof loadProfile>, days: number) => Promise<FoundJob[]>;
  save?: typeof saveRun;
  platform?: ApplicationPlatform;
} = {}) {
  const platform = deps.platform ?? 'naukri';
  const label = PLATFORM_NAMES[platform];
  const validUrl = (url: string) => platform === 'naukri' ? isNaukriUrl(url) : platform === 'external' ? !!publicHttps(url) : !!boardJobId(url, platform);
  let state: NaukriRunStatus = { running: false, mode: 'dry-run', stopping: false, startedAt: null, finishedAt: null, total: 0, completed: 0, current: null, message: '', answers: [], results: [], log: [], error: null };
  let controller: AbortController | null = null;
  let browser: BrowserContext | null = null;
  let current: Promise<void> | null = null;
  let pending: { token: string; finish: (action: HandoffAction) => void; profileHash: string } | null = null;
  const now = () => deps.now?.() ?? new Date();
  const logPath = () => deps.logFile ?? fileForLog();
  const status = () => structuredClone(state);

  function preview(options?: Partial<NaukriOptions>) {
    const settings = (deps.settings ?? loadSettings)();
    const o: NaukriOptions = { minScore: options?.minScore ?? settings.minScore, max: options?.max ?? settings.maxPerRun, days: options?.days ?? settings.days };
    const profile = (deps.profile ?? loadProfile)();
    const book = (deps.book ?? readAnswerBook)();
    const approved = book.answers.filter((a) => a.source === 'you' || a.source === undefined);
    const answersHash = digest(approved);
    const history = loadLog(logPath());
    const left = Math.max(0, DAILY_LIMIT - appliedToday(history, now()));
    const excluded: Record<string, number> = {};
    const skipped = (why: string) => { excluded[why] = (excluded[why] ?? 0) + 1; };
    const done = Object.values(history).filter((e) => e.status === 'applied' || e.status === 'already-applied' || uncertain(e));
    const doneIds = new Set(done.map((e) => e.jobId));
    const doneUrls = new Set(done.flatMap((e) => [e.url, ...(e.targetUrl ? [e.targetUrl] : [])]).map(applicationUrlKey));
    const doneKeys = new Set(done.filter((e) => e.company).map((e) => sameJobKey(e.company, e.title)));
    const qualified: StoredFoundJob[] = [];
    for (const job of listJobs((deps.load ?? loadStore)())) {
      if (!belongsToPlatform(job, platform) && !(platform === 'external' && history[job.id]?.status === 'external')) continue;
      if (!job.url || !validUrl(job.url)) { skipped('Invalid or unsupported job link'); continue; }
      const entry = history[job.id];
      if (doneIds.has(job.id) || doneUrls.has(applicationUrlKey(job.url)) || doneKeys.has(sameJobKey(job.company, job.title))) { skipped('Already applied or awaiting verification'); continue; }
      if (entry?.status === 'needs-answers' && entry.answersHash === answersHash) { skipped('Waiting for new confirmed answers'); continue; }
      if (platform !== 'external' && (job.flags.includes('apply:company-site') || entry?.status === 'external')) { skipped('Employer-site application'); continue; }
      if (!job.description?.trim()) { skipped('No saved job description'); continue; }
      if (platform !== 'naukri' && job.flags.some((f) => ['source:list-only', 'source:card-only'].includes(f))) { skipped('Full job description needed; find fresh jobs'); continue; }
      if (job.postedAt && Date.parse(job.postedAt) < now().getTime() - o.days * 86400000) { skipped('Outside your posting-date window'); continue; }
      const extraction = extractJob({ title: job.title, description: job.description, location: job.location, companyName: job.company });
      const titleStack = [...findSkills(job.title).keys()].filter((s) => ['language', 'runtime', 'framework'].includes(getSkill(s)?.category ?? ''));
      const primary = extraction.requiredSkills.filter((s) => ['language', 'runtime'].includes(getSkill(s)?.category ?? ''));
      if ((titleStack.length && !titleStack.some((s) => classifySkill(s, profile).level === 'strong')) || (primary.length && !primary.some((s) => classifySkill(s, profile).level === 'strong'))) { skipped('Primary stack is outside your professional strengths'); continue; }
      const match = scoreJob({ title: job.title, location: job.location, companyName: job.company, companySize: sizeFromTeam(job.teamSize), extraction }, profile);
      const fresh = { ...job, score: match.total, recommendation: match.recommendation, minYears: extraction.minYears, roleFamily: extraction.roleFamily, seniority: extraction.seniority };
      if (!['APPLY', 'STRONG_APPLY'].includes(match.recommendation) || rejectReason(fresh, { minScore: o.minScore, experienceYears: profile.experienceYears })) { skipped('Does not match your current profile and preferences'); continue; }
      qualified.push(fresh);
    }
    const keys = new Set<string>();
    const jobs = qualified.sort((a, b) => b.score - a.score || (b.postedAt ?? '').localeCompare(a.postedAt ?? '')).filter((j) => {
      const key = sameJobKey(j.company, j.title); if (keys.has(key)) { skipped('Duplicate posting'); return false; } keys.add(key); return true;
    }).slice(0, Math.min(o.max, left));
    const historyRows = Object.values(history).filter((e) => e.platform === platform || !e.platform && (platform === 'naukri' ? isNaukriUrl(e.url) : platform === 'external' ? !isNaukriUrl(e.url) && !boardJobId(e.url, 'hirist') && !boardJobId(e.url, 'instahyre') && !boardJobId(e.url, 'linkedin') && !boardJobId(e.url, 'wellfound') : !!boardJobId(e.url, platform))).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 60);
    const token = digest({ platform, o, jobs: jobs.map((j) => [j.id, j.url, j.score, j.description]), profile, answersHash, history, mode: (settings.autoApply[platform] ?? 'dry-run'), day: now().toDateString() });
    return { jobs, qualified: qualified.length, excluded, remainingToday: left, dailyLimit: DAILY_LIMIT, confirmedAnswers: approved.length, token, options: o, mode: (settings.autoApply[platform] ?? 'dry-run'), history: historyRows, resume: naukriResumeInfo() };
  }

  function say(message: string) { state.message = message; state.log.push(message); if (state.log.length > 100) state.log.shift(); }
  async function pause(signal: AbortSignal) {
    if (deps.pause) return deps.pause(signal);
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const end = () => { clearTimeout(timer); signal.removeEventListener('abort', end); resolve(); };
      const timer = setTimeout(end, 20000 + Math.random() * 20000);
      signal.addEventListener('abort', end, { once: true });
    });
  }

  return {
    preview,
    status,
    find(days: number) {
      if (state.running) throw new OutreachError(`A ${label} task is already running.`, 409);
      controller = new AbortController(); const signal = controller.signal;
      state = { running: true, mode: 'discover', stopping: false, startedAt: now().toISOString(), finishedAt: null, total: 0, completed: 0, current: null, answers: [], results: [], log: [], error: null, message: `Finding fresh ${label} jobs…` };
      current = (async () => {
        browser = await (deps.open ?? (() => openBrowser(false)))(); if (signal.aborted) return;
        const profile = (deps.profile ?? loadProfile)();
        say(`Reading ${label} only, using your logged-in Chrome.`);
        let jobs: FoundJob[];
        if (deps.collect) jobs = await deps.collect(browser, profile, days);
        else if (platform === 'linkedin') {
          const raw = await new LinkedInProvider().searchJobs(criteriaFor(profile, days), {});
          jobs = scoreRaw(raw, criteriaFor(profile, days), profile);
        } else if (platform === 'external') {
          const result = await searchJobs({ maxAgeDays: days });
          jobs = result.jobs.filter((job) => belongsToPlatform(job, platform));
          if (!jobs.length && result.warnings.length) throw new Error(result.warnings.join('; '));
        } else {
          const result = await readSite(browser, sitesByKey([platform])[0], { days, maxJobs: 15, enrichList: platform !== 'naukri' });
          if (result.error) throw new Error(result.error);
          jobs = scoreRaw(result.jobs, criteriaFor(profile, days), profile);
        }
        if (signal.aborted) return;
        (deps.save ?? saveRun)({ jobs, ranAt: now().toISOString() });
        state.total = jobs.length; state.completed = jobs.length;
        say(`Found ${jobs.length} ${label} jobs. Review the refreshed preview before applying.`);
      })().catch((error) => { if (!signal.aborted) { state.error = (error as Error).message; say(`${label} discovery needs attention. Check login or the browser message.`); } })
        .finally(async () => { await browser?.close().catch(() => undefined); browser = null; state.running = false; state.finishedAt = now().toISOString(); if (signal.aborted) say(`${label} discovery stopped.`); });
      return status();
    },
    settings(mode: 'off' | 'dry-run' | 'on', options: NaukriOptions) {
      if (state.running) throw new OutreachError(`Stop the current ${label} run before changing its settings.`, 409);
      const file = process.env.JOB_HUNTER_SETTINGS ?? SETTINGS_FILE;
      const settings = (deps.settings ?? loadSettings)();
      const next = { ...settings, ...{ minScore: options.minScore, maxPerRun: options.max, days: options.days }, autoApply: { ...settings.autoApply, [platform]: mode } };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${randomUUID()}.tmp`;
      try { fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); } finally { fs.rmSync(tmp, { force: true }); }
      return preview(options);
    },
    start(mode: 'dry-run' | 'apply', token: string, options: NaukriOptions) {
      if (state.running) throw new OutreachError(`A ${label} run is already in progress.`, 409);
      const plan = preview(options);
      if (token !== plan.token) throw new OutreachError('Your jobs, answers or settings changed. Refresh the preview before starting.', 409);
      if (mode === 'apply' && plan.mode !== 'on') throw new OutreachError(`Enable ${label} automatic submissions in this panel before starting.`, 409);
      if (!plan.jobs.length) throw new OutreachError(plan.remainingToday ? `No eligible ${label} jobs in this preview. Adjust the posting window or find fresh jobs.` : 'The daily application limit has been reached.', 422);
      controller = new AbortController();
      const signal = controller.signal;
      state = { running: true, mode, stopping: false, startedAt: now().toISOString(), finishedAt: null, total: plan.jobs.length, completed: 0, current: null, answers: [], results: [], log: [], error: null, message: `Starting ${label}…` };
      const profile = (deps.profile ?? loadProfile)();
      const profileHash = digest(profile);
      current = (async () => {
        browser = await (deps.open ?? (() => openBrowser(false)))();
        if (signal.aborted) return;
        browser.on?.('close', () => { if (state.handoff) controller?.abort(); });
        const page = await browser.newPage();
        for (const [i, job] of plan.jobs.entries()) {
          if (signal.aborted) break;
          if (digest((deps.profile ?? loadProfile)()) !== profileHash) throw new Error('Your candidate profile changed. Refresh the preview before continuing.');
          if (mode === 'apply' && appliedToday(loadLog(logPath()), now()) >= DAILY_LIMIT) { say('Daily application limit reached.'); break; }
          const history = loadLog(logPath());
          if (history[job.id] && (history[job.id].status === 'applied' || history[job.id].status === 'already-applied' || uncertain(history[job.id]))) continue;
          const book = (deps.book ?? readAnswerBook)();
          const answersHash = digest(book.answers.filter((a) => a.source === 'you' || a.source === undefined));
          const base: ApplyEntry = { platform, jobId: job.id, url: job.url!, title: job.title, company: job.company, at: now().toISOString(), status: 'dry-run', answersHash };
          state.current = { id: job.id, title: job.title, company: job.company }; state.answers = [];
          say(`${i + 1}/${plan.jobs.length}: ${job.company} — ${job.title}`);
          const result = await (deps.apply ?? (platform === 'naukri' ? applyNaukri : (page, job, ctx) => applyPlatform(platform, page, job, ctx)))(page, { id: job.id, url: job.url!, title: job.title, company: job.company, companyDomain: job.companyDomain }, {
            profile, answers: book.answers, resumeText: readResume(RESUME_TEXT_FILE), resumeFile: naukriResumeInfo().uploaded ? resumeFile() : undefined,
            dryRun: mode === 'dry-run', signal,
            refreshAnswers: () => (deps.book ?? readAnswerBook)().answers,
            handoff: (request) => new Promise<HandoffAction>((resolve) => {
              if (signal.aborted) return resolve('skip');
              const token = randomUUID();
              const finish = (action: HandoffAction) => { signal.removeEventListener('abort', abort); pending = null; state.handoff = null; resolve(action); };
              const abort = () => finish('skip');
              pending = { token, finish, profileHash };
              state.handoff = { ...request, url: displayLocation(request.url), token, jobId: job.id };
              say(request.message); signal.addEventListener('abort', abort, { once: true });
            }),
            beforeApply: (targetUrl) => {
              const target = targetUrl ?? job.url!;
              const latest = loadLog(logPath());
              const reservedToday = base.targetUrl && latest[job.id]?.status === 'verification-required' && appliedToday({ [job.id]: latest[job.id] }, now()) === 1;
              if (!reservedToday && appliedToday(latest, now()) >= DAILY_LIMIT) throw new Error('The daily application limit has been reached. No new submission was made.');
              const duplicate = Object.values(latest).some((entry) => entry.jobId !== job.id && (['applied', 'already-applied'].includes(entry.status) || uncertain(entry)) && [entry.url, entry.targetUrl].some((url) => url && applicationUrlKey(url) === applicationUrlKey(target)));
              if (duplicate) throw new Error('This destination already has an application or needs verification. No new submission was made.');
              base.targetUrl = target;
              record({ ...base, status: 'verification-required', note: 'Apply is starting. Verify this application if the process is interrupted.' }, logPath());
            },
            progress: (message, answers) => { say(message); if (answers) state.answers = answers; },
          });
          const entry: ApplyEntry = { ...base, ...result, at: now().toISOString() };
          record(entry, logPath()); state.results.push(entry); state.completed++;
          say(`${result.status}: ${job.company}${result.note ? ` — ${result.note}` : ''}`);
          if (/site application limit|easy apply limit|too many requests/i.test(result.note ?? '')) throw new Error(result.note);
          if (result.status === 'failed' && /login|browser check|certificate|application limit|easy apply limit|too many requests/i.test(result.note ?? '')) throw new Error(result.note);
          if (i < plan.jobs.length - 1 && !signal.aborted) await pause(signal);
        }
      })().catch((error) => { if (!signal.aborted) state.error = (error as Error).message; })
        .finally(async () => {
          await browser?.close().catch(() => undefined); browser = null;
          state.running = false; state.finishedAt = now().toISOString(); state.current = null; state.handoff = null; pending = null;
          say(signal.aborted ? `${label} run stopped. Check any application marked for verification before retrying.` : state.error ? 'Run stopped because an issue needs attention.' : `${label} run finished.`);
        });
      return status();
    },
    continue(token: string, action: HandoffAction) {
      if (!state.running || state.stopping || !pending || pending.token !== token) throw new OutreachError('This handoff is no longer active. Refresh the run status.', 409);
      if (action === 'resume' && digest((deps.profile ?? loadProfile)()) !== pending.profileHash) throw new OutreachError('Your profile changed. Stop this run and refresh the preview before starting again.', 409);
      pending.finish(action); say(action === 'resume' ? 'Re-checking the application after your input…' : 'Skipping this application; verify its status before any retry.');
      return status();
    },
    async stop() { if (state.running) { state.stopping = true; controller?.abort(); await browser?.close().catch(() => undefined); } return status(); },
    allowRetry(jobId: string) {
      if (state.running) throw new OutreachError(`Stop the ${label} run before changing application history.`, 409);
      const entry = loadLog(logPath())[jobId];
      if (!entry || entry.platform && entry.platform !== platform || !validUrl(entry.url) || !uncertain(entry)) throw new OutreachError(`Only an unverified ${label} application can be released for retry.`, 409);
      record({ ...entry, status: 'failed', note: `You checked ${label} and marked this job as not applied; retry permitted.` }, logPath());
    },
    reconcile() { if (state.running) throw new OutreachError(`Wait for the ${label} run to finish before checking saved confirmations.`, 409); return platform === 'naukri' ? reconcileNaukriConfirmations(logPath()) : []; },
    async settled() { await current; },
  };
}
