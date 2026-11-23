import * as fs from 'fs';
import * as path from 'path';
import type { Locator, Page } from 'playwright';
import type { CandidateProfile } from '../domain/profile/profile';
import { findSkills } from '../domain/skills/taxonomy';
import { READ_FIELDS } from './form-controls';
import { planFormAnswers, type FormAnswer, type FormField } from './form-answers';
import { matchAnswer, pickOption, rememberQuestion, type Answer } from './answers';
import type { ApplyStatus } from './log';
import { hasNaukriConfirmation } from './naukri-confirmation';
import type { HandoffAction, HandoffRequest } from './handoff';
import { pageInterruption } from './page-interruption';

export const isNaukriUrl = (value: string) => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && (url.hostname === 'naukri.com' || url.hostname.endsWith('.naukri.com')); } catch { return false; }
};
const jobId = (value: string) => new URL(value).pathname.match(/-(\d{9,})\/?$/)?.[1];
const isJobPage = (value: string) => { try { return /\/job-listings-/.test(new URL(value).pathname); } catch { return false; } };
const nextName = /^\s*(save(?: and continue)?|next|continue(?: to next step)?|review(?: your application)?|submit(?: (?:your )?application)?|send(?: application)?|done|apply(?: now)?)\s*$/i;

export interface NaukriContext {
  profile: CandidateProfile;
  answers: Answer[];
  resumeText: string;
  resumeFile?: string;
  dryRun: boolean;
  signal?: AbortSignal;
  beforeApply?: (url?: string) => void;
  progress?: (message: string, answers?: FormAnswer[]) => void;
  allowTestUrl?: (url: string) => boolean;
  plan?: typeof planFormAnswers;
  waitMs?: number;
  handoff?: (request: HandoffRequest) => Promise<HandoffAction>;
  refreshAnswers?: () => Answer[];
}
export interface NaukriResult { status: ApplyStatus; note?: string }
export interface Step { root: Locator; fields: FormField[]; question: string; signature: string; chat: boolean }
export class NaukriAnswerError extends Error {}

async function firstVisible(locator: Locator): Promise<Locator | null> {
  for (let i = 0; i < await locator.count(); i++) if (await locator.nth(i).isVisible().catch(() => false)) return locator.nth(i);
  return null;
}
async function saveSnapshot(page: Page, id: string, stage: string) {
  const dir = process.env.JOB_HUNTER_SNAPSHOTS ?? path.resolve(__dirname, '../../.cache/snapshots');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `naukri-${id.slice(0, 10)}-${stage}.html`), await page.content(), { mode: 0o600 });
}

const READ_CHAT = `(() => {
  const root = document.querySelector('[data-job-hunter-scope]');
  const visible = e => !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const messages = [...root.querySelectorAll('.botItem .botMsg')].filter(visible);
  const label = (messages.at(-1)?.innerText || root.querySelector('legend, p, h3')?.innerText || '').replace(/\\s+/g,' ').trim();
  const labels = e => e.getAttribute('aria-label') || [...(e.labels || [])].map(l=>l.innerText.trim()).join(' ') || e.innerText?.trim() || '';
  const radios = [...root.querySelectorAll('input[type="radio"]')].filter(e=>visible(e)||[...(e.labels||[])].some(visible));
  const checkbox = [...root.querySelectorAll('input[type="checkbox"]')].filter(e=>visible(e)||[...(e.labels||[])].some(visible));
  const roles = [...root.querySelectorAll('[role="radio"],[role="option"]')].filter(visible);
  const choice = radios.length ? radios : checkbox.length ? checkbox : roles;
  const id = 'naukri-question';
  let kind, value = '', options = [], target;
  if(choice.length) {
    kind = checkbox.length && !radios.length ? 'checkboxes' : 'radio';
    options = choice.map(labels);
    choice.forEach((e,i)=>{ e.setAttribute('data-job-hunter-field',id); [...(e.labels||[])].forEach(l=>{l.setAttribute('data-naukri-choice',id+'-'+i);}); });
    if(kind === 'checkboxes' && /privacy|consent|agree|terms|declaration/i.test(label)) kind='manual';
  } else {
    target = [...root.querySelectorAll('select, textarea, input:not([type="hidden"]):not([type="file"]), [contenteditable="true"]')].find(visible);
    if(!target && /\\b(resume|cv|curriculum vitae)\\b/i.test(label)) target = root.querySelector('input[type="file"]');
    if(!target) return {question:label, fields:[]};
    kind = target.tagName === 'SELECT' ? 'select' : target.type === 'file' ? 'manual' : target.getAttribute('role') === 'combobox' ? 'combobox' : target.type === 'number' ? 'number' : target.isContentEditable || target.tagName === 'TEXTAREA' ? 'textarea' : 'text';
    if(kind === 'select') options = [...target.options].map(o=>o.textContent.trim());
    value = target.isContentEditable ? target.innerText : target.value || '';
    if(kind === 'select' && (!value || /^(select|choose)/i.test(target.options[target.selectedIndex]?.textContent.trim()||''))) value='';
    target.setAttribute('data-job-hunter-field',id);
  }
  return {question:label,fields:[{id,label,kind,value,options,required:!/\\boptional\\b/i.test(label)}]};
})()`;

const READ_GROUPS = `(() => {
  const scope=document.querySelector('[data-job-hunter-scope]'), result=[];
  for(const [i,group] of [...scope.querySelectorAll('fieldset,[role="radiogroup"]')].entries()) {
    const label=(group.querySelector('legend')?.innerText||group.getAttribute('aria-label')||'').trim();
    if(!label||/privacy|consent|agree|terms|declaration/i.test(label)) continue;
    const inputs=[...group.querySelectorAll('input[type="checkbox"],input[type="radio"]')].filter(e=>!e.disabled);
    if(inputs.length<2) continue;
    const previous=inputs.map(e=>e.getAttribute('data-job-hunter-field')).filter(Boolean);
    const id='naukri-group-'+i;
    const options=inputs.map((e,n)=>{e.setAttribute('data-job-hunter-field',id);[...(e.labels||[])].forEach(l=>l.setAttribute('data-naukri-choice',id+'-'+n));return [...(e.labels||[])].map(l=>l.innerText.trim()).join(' ')||e.value;});
    result.push({previous,field:{id,label,kind:inputs[0].type==='radio'?'radio':'checkboxes',options,value:inputs.filter(e=>e.checked).map(e=>e.value).join(', '),required:!/optional/i.test(label)}});
  }
  return result;
})()`;

export async function readStep(page: Page): Promise<Step | null> {
  const chat = await firstVisible(page.locator('.chatbot_DrawerContentWrapper, .chatbot_Drawer, [data-naukri-chat]'));
  if (chat) {
    await chat.evaluate((element) => element.setAttribute('data-job-hunter-scope', 'true'));
    const data = await page.evaluate<{ question: string; fields: FormField[] }>(READ_CHAT);
    await chat.evaluate((element) => element.removeAttribute('data-job-hunter-scope'));
    return { root: chat, ...data, signature: JSON.stringify([data.question, data.fields.map((f) => [f.kind, f.options])]), chat: true };
  }
  const candidates = page.locator('[role="dialog"], form, [class*="questionnaire" i], [class*="application-form" i], .instascreen-apply-modal, [data-automation-id="jobApplication"], [data-automation-id="applicationPage"]');
  for (let i = 0; i < await candidates.count(); i++) {
    const root = candidates.nth(i);
    if (!await root.isVisible() || !await root.locator('input,textarea,select,[contenteditable="true"],[role="combobox"],[aria-haspopup="listbox"],[role="checkbox"]').count()) continue;
    if (!await firstVisible(root.getByRole('button', { name: nextName })) && await root.getAttribute('role') !== 'dialog') continue;
    await root.evaluate((element) => element.setAttribute('data-job-hunter-scope', 'true'));
    let fields = await page.evaluate<FormField[]>(READ_FIELDS);
    const groups = await page.evaluate<Array<{ previous: string[]; field: FormField }>>(READ_GROUPS);
    for (const group of groups) fields = [...fields.filter((f) => !group.previous.includes(f.id)), group.field];
    await root.evaluate((element) => element.removeAttribute('data-job-hunter-scope'));
    for (const field of fields) {
      const control = root.locator(`[data-job-hunter-field="${field.id}"]`).first();
      if (field.kind === 'radio' && !field.id.startsWith('naukri-group-')) await root.locator(`[data-job-hunter-field="${field.id}"]`).evaluateAll((elements, id) => elements.forEach((element, index) => {
        const label = [...element.ownerDocument.querySelectorAll('label')].find((l) => l.getAttribute('for') === element.getAttribute('id'));
        label?.setAttribute('data-naukri-choice', `${id}-${index}`);
      }), field.id);
      if (field.kind === 'manual' && await control.getAttribute('type') === 'checkbox' && await control.isChecked()) field.value = 'Already selected';
      if (field.kind === 'manual' && await control.getAttribute('role') === 'combobox') { field.kind = 'combobox'; field.reason = undefined; }
      if (fields.length === 1 && field.label === 'Unlabelled field') {
        const heading = root.locator('p,legend,h3').first();
        const question = (await heading.count() ? await heading.innerText() : '').trim();
        if (question) {
          field.label = question;
          const tag = await control.evaluate((e) => e.tagName.toLowerCase());
          const type = await control.getAttribute('type');
          field.kind = tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : type === 'number' ? 'number' : ['file', 'checkbox', 'date'].includes(type ?? '') ? 'manual' : 'text';
          field.reason = undefined;
        }
      }
    }
    if (fields.length) return { root, fields, question: fields.map((f) => f.label).join('; '), signature: JSON.stringify([fields.map((f) => [f.label, f.kind, f.options]), await root.locator('h2,h3,legend,[data-automation-id="pageHeaderTitle"]').allInnerTexts(), await root.getByRole('button').allInnerTexts()]), chat: false };
  }
  return null;
}

function optionIndex(options: string[], value: string): number {
  const exact = options.flatMap((o, i) => o.trim().toLowerCase() === value.trim().toLowerCase() ? [i] : []);
  const matches = exact.length ? exact : /^\d/.test(value) ? options.flatMap((o, i) => pickOption([o], value) === 0 ? [i] : []) : [];
  return matches.length === 1 ? matches[0] : -1;
}
export async function fillField(step: Step, field: FormField, value: string, ctx: NaukriContext) {
  if (ctx.signal?.aborted) throw new Error('Stopped before filling the answer.');
  const controls = step.root.locator(`[data-job-hunter-field="${field.id}"]`);
  if (field.kind === 'select') {
    const i = optionIndex(field.options, value); if (i < 0) throw new NaukriAnswerError('No single dropdown option matches the verified answer.');
    await controls.first().selectOption({ index: i }, { timeout: 3000 });
  } else if (field.kind === 'radio' || field.kind === 'checkboxes') {
    const values = field.kind === 'checkboxes' ? value.split(/[,;\n]+/).map((v) => v.trim()).filter(Boolean) : [value];
    const indexes = values.map((v) => optionIndex(field.options, v));
    if (!indexes.length || indexes.some((i) => i < 0)) throw new NaukriAnswerError('The selected options need your answer.');
    for (const i of indexes) {
      const control = controls.nth(i);
      if (await control.isVisible()) {
        const role = await control.getAttribute('role');
        if (role === 'radio' || role === 'option') await control.click({ timeout: 3000 }); else await control.check({ timeout: 3000 });
      } else await step.root.locator(`[data-naukri-choice="${field.id}-${i}"]`).click({ timeout: 3000 });
    }
  } else if (field.kind === 'combobox') {
    const control = controls.first(); await control.click({ timeout: 3000 });
    if (await control.isEditable()) await control.fill(value, { timeout: 3000 });
    const page = control.page();
    const option = page.getByRole('option', { name: value, exact: true });
    await option.first().waitFor({ state: 'visible', timeout: 5000 });
    if (await option.count() !== 1) throw new NaukriAnswerError('The autocomplete options are ambiguous.');
    await option.click({ timeout: 3000 });
  } else await controls.first().fill(value, { timeout: 3000 });
}

export async function stepAnswers(fields: FormField[], ctx: NaukriContext) {
  const confirmed = (ctx.refreshAnswers?.() ?? ctx.answers).filter((a) => a.source === undefined || a.source === 'you');
  const rest: FormField[] = [];
  const derived: FormAnswer[] = [];
  for (const field of fields) {
    const skills = [...findSkills(field.label).keys()];
    const yesNo = field.options.some((o) => /^yes$/i.test(o)) && field.options.some((o) => /^no$/i.test(o));
    const explicit = matchAnswer(field.label, confirmed, ctx.profile.strongSkills);
    // Presence of professional experience is different from an exact number of years.
    if (yesNo && !/^(yes|no)$/i.test(explicit ?? '') && skills.length && skills.every((s) => ctx.profile.strongSkills.includes(s)) && /experience|worked|working|proficien|familiar/i.test(field.label) && !/\b(years?|months?|minimum|at least|more than|less than|over|under)\b|\d/i.test(field.label)) {
      derived.push({ id: field.id, label: field.label, value: 'Yes', source: 'profile', reason: 'Every named skill is listed as professional experience in your profile.', canSave: false });
    } else rest.push(field);
  }
  const result = await (ctx.plan ?? planFormAnswers)(rest, ctx.profile, confirmed, ctx.resumeText, { automatic: true, signal: ctx.signal });
  return { answers: fields.map((f) => derived.find((a) => a.id === f.id) ?? result.answers.find((a) => a.id === f.id)!), warning: result.warning };
}

/** Naukri-only flow: an explicit submit run can click Apply, answer screening steps, and confirm completion. */
export async function applyNaukri(page: Page, job: { id: string; url: string; title: string; company?: string; companyDomain?: string | null }, ctx: NaukriContext): Promise<NaukriResult> {
  const allowed = (url: string) => isNaukriUrl(url) || !!ctx.allowTestUrl?.(url);
  if (!allowed(job.url)) return { status: 'external', note: 'Not a supported Naukri job URL.' };
  let attempted = false;
  let manualExposed = false;
  async function ask(reason: HandoffRequest['reason'], message: string) {
    if (!ctx.handoff || ctx.dryRun || ctx.signal?.aborted) return false;
    ctx.beforeApply?.(job.url); attempted = true; manualExposed = true;
    return await ctx.handoff({ reason, message, url: page.url() }) === 'resume' && !ctx.signal?.aborted;
  }
  const stopped = (): NaukriResult => ({ status: attempted ? 'verification-required' : 'dry-run', note: attempted ? 'Stopped after Apply. Check Naukri before retrying this job.' : 'Stopped before Apply.' });
  const wait = ctx.waitMs ?? 15000;
  async function completed(): Promise<boolean> {
    if (await hasNaukriConfirmation(page, job.title)) return true;
    const success = await firstVisible(page.locator('[role="status"], [role="alert"], .application-success, .success-message'));
    const text = success ? await success.innerText() : ctx.allowTestUrl?.(page.url()) ? await page.locator('body').innerText().catch(() => '') : '';
    return /successfully applied|you have applied|applied successfully|application (?:has been )?(?:sent|submitted)/i.test(text);
  }
  async function alreadyApplied() { return !!await firstVisible(page.locator('#already-applied').or(page.getByRole('button', { name: /^\s*applied\s*$/i })).or(page.getByText(/^\s*applied\s*$/i))); }
  async function waitForState(previous?: string) {
    const until = Date.now() + wait;
    while (Date.now() < until) {
      if (ctx.signal?.aborted || await completed() || await alreadyApplied() || !allowed(page.url())) return;
      const step = await readStep(page);
      if (step && step.fields.length && (!previous || step.signature !== previous)) return;
      if (await firstVisible(page.locator('[role="alert"], .error-message, .error-msg, .chatbot_Error'))) return;
      await page.waitForTimeout(250);
    }
  }
  try {
    if (ctx.signal?.aborted) return stopped();
    ctx.progress?.('Opening the Naukri job.');
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(ctx.waitMs === undefined ? 1500 : 20);
    const readyBy = Date.now() + wait;
    while (Date.now() < readyBy && !ctx.signal?.aborted) {
      if (!allowed(page.url()) || await firstVisible(page.locator('#apply-button, #already-applied, #company-site-button')) || /login|captcha|access denied/i.test(await page.title())) break;
      if (!ctx.allowTestUrl?.(page.url()) && !isJobPage(page.url())) break;
      if (/no longer accepting|job (?:has )?expired|position (?:has been )?closed/i.test(await page.locator('body').innerText().catch(() => ''))) break;
      if (await firstVisible(page.getByRole('button', { name: /^\s*(apply|applied|apply now|apply on company site)\s*$/i }))) break;
      await page.waitForTimeout(200);
    }
    for (let i = 0; i < 4; i++) {
      const interruption = await pageInterruption(page); if (!interruption) break;
      if (!await ask(interruption.reason, interruption.message)) return { status: attempted ? 'verification-required' : 'failed', note: 'Naukri login or browser check required. Use Setup or complete the active Chrome handoff.' };
      if (!isJobPage(page.url()) && !await completed()) await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
    if (!allowed(page.url())) return { status: attempted ? 'verification-required' : 'external', note: 'Naukri redirected to an employer website; left for manual application.' };
    if (/login|sign in|captcha|access denied|just a moment/i.test(await page.title()) || /\/login|nlogin/.test(page.url())) return { status: 'failed', note: 'Naukri login or browser check required. Use Setup to complete it yourself.' };
    if (await alreadyApplied() || await completed()) return { status: attempted ? 'applied' : 'already-applied' };
    if (!ctx.allowTestUrl?.(page.url()) && (!isJobPage(page.url()) || (jobId(job.url) && jobId(page.url()) !== jobId(job.url)))) return { status: 'no-button', note: 'The original job now redirects to a different page or search results. It was not applied to.' };
    const title = page.locator('h1').first();
    const heading = (await title.count() ? await title.innerText() : '').trim();
    const titleKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (heading && titleKey(heading) !== titleKey(job.title)) return { status: 'no-button', note: 'The job title changed since discovery. Refresh this job before applying.' };
    const external = await firstVisible(page.locator('#company-site-button').or(page.getByRole('button', { name: /apply on company (?:site|website)/i })));
    if (external) return { status: 'external', note: 'This application must be completed on the employer website.' };
    const button = await firstVisible(page.locator('#apply-button').or(page.getByRole('button', { name: /^\s*(apply|apply now|easy apply|quick apply)\s*$/i })));
    if (!button) return { status: 'no-button', note: 'No active Naukri Apply control. The job may be closed.' };
    if (ctx.dryRun) { await saveSnapshot(page, job.id, 'job'); return { status: 'dry-run', note: 'Naukri Apply control verified. No application was sent.' }; }
    if (ctx.signal?.aborted) return stopped();
    ctx.beforeApply?.(); attempted = true;
    ctx.progress?.('Clicking Naukri Apply.');
    await button.click({ timeout: 10000 });
    await waitForState();
    for (let stepNumber = 0; stepNumber < 25; stepNumber++) {
      if (await completed() || await alreadyApplied()) {
        await saveSnapshot(page, job.id, 'after-click');
        return { status: 'applied', note: 'Naukri confirmed this application.' };
      }
      if (ctx.signal?.aborted) return stopped();
      const interruption = await pageInterruption(page);
      if (interruption) {
        if (await ask(interruption.reason, interruption.message)) continue;
        return { status: attempted ? 'verification-required' : 'failed', note: interruption.message };
      }
      if (!allowed(page.url())) return { status: 'external', note: 'Application continued on an employer website; left for manual completion.' };
      if (manualExposed && jobId(job.url) && jobId(page.url()) !== jobId(job.url)) return { status: 'verification-required', note: 'The handoff moved to another posting. Verify this application before retrying.' };
      if (await firstVisible(page.locator('input[type="password"]'))) return { status: 'failed', note: 'Naukri login is required before applying. Complete it in Setup.' };
      const step = await readStep(page);
      if (!step?.fields.length) break;
      await saveSnapshot(page, job.id, `question-${stepNumber}`);
      const uploads = step.fields.filter((f) => f.kind === 'manual' && /\b(resume|cv|curriculum vitae)\b/i.test(f.label));
      if (uploads.length && ctx.resumeFile) {
        for (const field of uploads) {
          const input = step.root.locator(`[data-job-hunter-field="${field.id}"]`);
          if (await input.getAttribute('type') === 'file') { await input.setInputFiles(ctx.resumeFile, { timeout: 5000 }); field.value = path.basename(ctx.resumeFile); }
        }
      }
      ctx.progress?.(`Checking screening step ${stepNumber + 1}: ${step.question.slice(0, 150)}`);
      const result = await stepAnswers(step.fields.filter((f) => !f.value), ctx);
      ctx.progress?.(`Screening step ${stepNumber + 1}: ${step.question.slice(0, 150)}`, result.answers);
      if (ctx.signal?.aborted) return stopped();
      const missing = result.answers.filter((a) => a.value === null && step.fields.find((f) => f.id === a.id)?.required !== false);
      if (missing.length) {
        for (const answer of missing) if (answer.canSave) rememberQuestion(answer.label, 'Naukri', job.title);
        const note = `${missing.map((a) => `${a.label}: ${a.reason}`).join('; ').slice(0, 1500)}${result.warning ? ` Ollama: ${result.warning}` : ''}`;
        if (await ask('answers', note + ' Save confirmed answers or complete this step in Chrome, then continue.')) continue;
        return { status: manualExposed ? 'verification-required' : 'needs-answers', note };
      }
      for (const answer of result.answers) if (answer.value !== null) {
        if (ctx.signal?.aborted) return stopped();
        try { await fillField(step, step.fields.find((f) => f.id === answer.id)!, answer.value, ctx); }
        catch (error) {
          if (!(error instanceof NaukriAnswerError)) throw error;
          rememberQuestion(answer.label, 'Naukri', job.title);
          return { status: 'needs-answers', note: `${answer.label}: ${(error as Error).message}` };
        }
      }
      // Some Naukri options advance immediately. Do not send the next question accidentally.
      if (await completed()) continue;
      const fresh = await readStep(page);
      if (fresh && fresh.signature !== step.signature) continue;
      const next = await firstVisible(step.root.getByRole('button', { name: nextName }).or(step.root.locator('[id^="sendMsg__"] .sendMsg, .sendMsg[tabindex="0"]')));
      if (!next) return { status: 'needs-answers', note: 'The screening step has no supported Save, Next or Submit control. Review it manually.' };
      if (await next.isDisabled() || /\bdisabled\b/.test((await next.getAttribute('class')) ?? '') || await next.getAttribute('aria-disabled') === 'true') return { status: 'needs-answers', note: 'Naukri did not accept an answer. Review the field validation.' };
      if (ctx.signal?.aborted) return stopped();
      await next.click({ timeout: 5000 });
      await waitForState(step.signature);
      if (await completed()) continue;
      const error = await firstVisible(step.root.locator('[role="alert"], .error-message, .error-msg, .chatbot_Error'));
      if (error) return { status: 'needs-answers', note: `Naukri validation: ${(await error.innerText()).slice(0, 500)}` };
      const after = await readStep(page);
      if (after?.signature === step.signature) return { status: 'verification-required', note: 'The screening step did not advance after Save. Check Naukri before retrying.' };
    }
    await saveSnapshot(page, job.id, 'after-click');
    return { status: 'verification-required', note: 'Apply was clicked but no confirmation could be verified. This job will not be retried automatically.' };
  } catch (error) {
    if (ctx.signal?.aborted) return stopped();
    const message = (error as Error).message.split('\n')[0];
    return { status: attempted ? 'verification-required' : 'failed', note: /ERR_CERT_AUTHORITY_INVALID/.test(message) ? 'Chrome could not verify Naukri’s TLS certificate. Fix certificate trust in Chrome; certificate checks were not disabled.' : message };
  }
}
