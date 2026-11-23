import type { BrowserContext, Page, Route } from 'playwright';
import { openBrowser } from '../browser/runner';
import { sitesByKey } from '../browser/sites';
import { loadProfile, type FoundJob } from '../search';
import { readResume, RESUME_TEXT_FILE } from '../discover/insights';
import { OutreachError } from '../outreach/ollama';
import { SITE_FOR_SOURCE } from './engine';
import { READ_FIELDS } from './form-controls';
import { pickOption, rememberQuestion } from './answers';
import { planFormAnswers, readAnswerBook, type FormAnswer, type FormField } from './form-answers';

export interface ReviewStatus {
  running: boolean;
  phase: 'idle' | 'opening' | 'waiting' | 'filling' | 'review' | 'closed' | 'failed';
  kind: 'application' | 'login';
  job: { id: string; title: string; company: string } | null;
  site: string | null;
  answers: FormAnswer[];
  warning: string | null;
  error: string | null;
  message: string;
  paused: boolean;
}

const GUARD = `(() => {
  if (window.__jobHunterGuard) return;
  const state = window.__jobHunterGuard = { paused: false };
  document.addEventListener('submit', e => { if (state.paused) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  document.addEventListener('click', e => { if (state.paused && e.target.closest?.('button, a, input[type="submit"], input[type="image"]')) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  document.addEventListener('keydown', e => { if (state.paused && e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  const submit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function() { if (!state.paused) return submit.apply(this, arguments); };
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function() { if (!state.paused) return send.apply(this, arguments); };
})()`;

function validBoardUrl(value: string, site: string) {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  const domains: Record<string, string[]> = { naukri: ['naukri.com'], hirist: ['hirist.com', 'hirist.tech'], instahyre: ['instahyre.com'] };
  return url.protocol === 'https:' && !url.username && !url.password && domains[site]?.some((d) => url.hostname === d || url.hostname.endsWith(`.${d}`));
}

export function createApplicationReview(deps: {
  open?: () => Promise<BrowserContext>;
  profile?: typeof loadProfile;
  resume?: () => string;
  book?: typeof readAnswerBook;
  plan?: typeof planFormAnswers;
  allowTestUrl?: (url: string) => boolean;
} = {}) {
  let state: ReviewStatus = { running: false, phase: 'idle', kind: 'application', job: null, site: null, answers: [], warning: null, error: null, message: '', paused: false };
  let browser: BrowserContext | null = null;
  let page: Page | null = null;
  let generation = 0;
  let opening: Promise<void> | null = null;
  let filling: Promise<ReviewStatus> | null = null;
  const blocked = (route: Route) => route.abort('blockedbyclient');
  const status = (): ReviewStatus => structuredClone(state);

  async function setPaused(paused: boolean) {
    if (!browser) return;
    if (paused && !state.paused) await browser.route('**/*', blocked);
    for (const p of browser.pages()) await p.evaluate(`window.__jobHunterGuard && (window.__jobHunterGuard.paused = ${paused})`).catch(() => undefined);
    if (!paused && state.paused) await browser.unroute('**/*', blocked);
    state.paused = paused;
  }

  function start(url: string, site: string, job: FoundJob | null) {
    if (state.running) throw new OutreachError('A Chrome session is already open. Close it before starting another.', 409);
    const token = ++generation;
    state = { running: true, phase: 'opening', kind: job ? 'application' : 'login', job: job ? { id: job.id, title: job.title, company: job.company } : null, site, answers: [], warning: null, error: null, paused: false, message: 'Opening your logged-in Chrome…' };
    opening = (async () => {
      const context = await (deps.open ?? (() => openBrowser(false, undefined, { serviceWorkers: 'block' })))();
      if (token !== generation) { await context.close(); return; }
      browser = context;
      context.on('close', () => { if (token === generation) { state = { ...state, running: false, phase: 'closed', paused: false, message: 'Chrome session closed.' }; browser = null; page = null; } });
      await context.addInitScript(GUARD);
      context.on('page', (p) => { page = p; });
      page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (token !== generation) return;
      state.phase = 'waiting';
      state.message = job ? 'Open the application form in Chrome, then click “Fill visible form” here.' : 'Log in directly in Chrome. Close this session when you finish.';
    })().catch(async (error) => {
      if (token !== generation) return;
      const context = browser; browser = null; page = null;
      await context?.close().catch(() => undefined);
      state = { ...state, running: false, phase: 'failed', error: `Could not open Chrome: ${(error as Error).message.split('\n')[0]}. Close other Job Hunter Chrome sessions and try again.`, message: '' };
    });
    return status();
  }

  return {
    status,
    open(job: FoundJob) {
      const site = SITE_FOR_SOURCE[job.source];
      if (!site || !job.url || (!validBoardUrl(job.url, site) && !deps.allowTestUrl?.(job.url))) throw new OutreachError('Fill and review currently supports saved Naukri, Hirist and Instahyre job links.', 422);
      if (job.flags.includes('apply:company-site')) throw new OutreachError('This job redirects to the employer site. Complete that application manually.', 422);
      return start(job.url, site, job);
    },
    login(site: string) {
      if (!['naukri', 'hirist', 'instahyre', 'wellfound', 'linkedin'].includes(site)) throw new OutreachError('Choose a supported job board.', 400);
      return start(site === 'linkedin' ? 'https://www.linkedin.com/login' : sitesByKey([site])[0].loginUrl, site, null);
    },
    async fill() {
      if (!browser || !page || state.kind !== 'application' || !['waiting', 'review'].includes(state.phase)) throw new OutreachError('Open an application and wait for Chrome before filling.', 409);
      if (state.paused) throw new OutreachError('Enable page controls before filling another step.', 409);
      if (!validBoardUrl(page.url(), state.site!) && !deps.allowTestUrl?.(page.url())) throw new OutreachError('This page is outside the supported job board. Complete it manually.', 422);
      const currentPage = page;
      const token = generation;
      state = { ...state, phase: 'filling', answers: [], error: null, warning: null, message: 'Reading and filling the visible form…' };
      try {
        if (/login|sign in|captcha|access denied|just a moment/i.test(await currentPage.title()) || /\/login|nlogin/.test(currentPage.url())) throw new OutreachError('Finish login or the browser check yourself, then open the application form.', 422);
        await currentPage.evaluate(GUARD);
        await setPaused(true);
        const fields = await currentPage.evaluate<FormField[]>(READ_FIELDS);
        if (!fields.length) throw new Error('No supported application fields are visible. Open the form, then try again.');
        const result = await (deps.plan ?? planFormAnswers)(fields, (deps.profile ?? loadProfile)(), (deps.book ?? readAnswerBook)().answers, (deps.resume ?? (() => readResume(RESUME_TEXT_FILE)))());
        if (token !== generation || !browser || currentPage.isClosed()) return status();
        for (const answer of result.answers) {
          if (token !== generation || !browser || currentPage.isClosed()) return status();
          const field = fields.find((f) => f.id === answer.id)!;
          if (answer.value === null) {
            if (!field.value && answer.canSave) rememberQuestion(field.label, state.site!, state.job!.title);
            continue;
          }
          const control = currentPage.locator(`[data-job-hunter-field="${field.id}"]`);
          try {
            if (field.kind === 'select' || field.kind === 'radio') {
              const exact = field.options.flatMap((option, i) => option.trim().toLowerCase() === answer.value!.trim().toLowerCase() ? [i] : []);
              const matches = exact.length ? exact : /^\d/.test(answer.value) ? field.options.flatMap((option, i) => pickOption([option], answer.value!) === 0 ? [i] : []) : [];
              if (matches.length !== 1) throw new Error('No single option matches the verified answer.');
              if (field.kind === 'select') await control.selectOption({ index: matches[0] }, { timeout: 2500 });
              else await control.nth(matches[0]).check({ timeout: 2500 });
            } else await control.fill(answer.value, { timeout: 2500 });
          } catch (error) {
            answer.value = null; answer.reason = `Not filled: ${(error as Error).message.split('\n')[0]}`;
          }
        }
        if (token !== generation || !browser) return status();
        state = { ...state, phase: 'review', answers: result.answers, warning: result.warning, message: 'Review the values in Chrome. Page controls and requests are paused. Enable page controls when you are ready to continue manually.' };
      } catch (error) {
        if (token === generation) state = { ...state, phase: 'review', error: (error as Error).message, message: 'Review in Chrome, or enable page controls to open the right form.' };
      }
      return status();
    },
    startFill() {
      if (!browser || !page || state.kind !== 'application' || !['waiting', 'review'].includes(state.phase) || state.paused) throw new OutreachError('Open the form and enable page controls before filling another step.', 409);
      const token = generation;
      filling = this.fill().catch((error) => {
        if (token === generation) state = { ...state, phase: 'review', error: (error as Error).message };
        return status();
      });
      return status();
    },
    async resume() {
      if (!state.running || state.phase === 'filling' || state.phase === 'opening') throw new OutreachError('Wait for autofill to finish before continuing.', 409);
      await setPaused(false);
      state.phase = 'waiting'; state.message = 'You control Chrome. Move to the next step yourself, then use “Fill visible form” again. Submit only after your review.';
      return status();
    },
    async close() {
      ++generation;
      const context = browser; browser = null; page = null;
      await context?.close();
      state = { ...state, running: false, phase: 'closed', paused: false, message: 'Chrome session closed.' };
      return status();
    },
    async settled() { await opening; await filling; },
  };
}
