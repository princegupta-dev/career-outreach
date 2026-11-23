import * as fs from 'fs';
import * as path from 'path';
import type { Locator, Page } from 'playwright';
import { fillField, NaukriAnswerError, readStep, stepAnswers, type NaukriContext, type NaukriResult } from './naukri';
import { rememberQuestion } from './answers';
import { applicationUrlKey, atsTarget, boardJobId, PLATFORM_NAMES, publicHttps, type ApplicationPlatform } from './platforms';
import { openInstahyreOpportunity } from './instahyre-opportunity';
import { pageInterruption } from './page-interruption';
import type { HandoffReason } from './handoff';

type Platform = Exclude<ApplicationPlatform, 'naukri'>;
type Target = { kind: string; key: string };
type Job = { id: string; url: string; title: string; company?: string; companyDomain?: string | null };
const APPLY = /^\s*(apply(?: now| for this (?:job|position))?|quick apply|i['’]?m interested|interested|submit application)\s*$/i;
const NEXT = /^\s*(apply(?: now)?|submit(?: (?:your )?application)?|send application|next|continue(?: to next step)?|review(?: your application)?|save(?: and continue)?)\s*$/i;
const SUCCESS = /^(?:thank(?:s| you) for (?:your interest|applying)[.!]?|application (?:successfully )?(?:sent|submitted|received)[.!]?|(?:you have |you['’]ve )?(?:successfully applied|applied successfully)(?: (?:for|to) this job)?[.!]?|interest (?:sent|shown)[.!]?|your application (?:has been |was )?(?:successfully )?(?:submitted|received)[.!]?)$/i;
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function companyHost(value: string, domain?: string | null) {
  if (!domain) return false;
  try { const base = new URL(domain.includes('://') ? domain : `https://${domain}`).hostname.replace(/^www\./, ''); const host = new URL(value).hostname; return host === base || host.endsWith(`.${base}`); } catch { return false; }
}
async function visible(locator: Locator): Promise<Locator | null> {
  for (let i = 0; i < await locator.count(); i++) if (await locator.nth(i).isVisible().catch(() => false)) return locator.nth(i);
  return null;
}
async function unique(locator: Locator): Promise<Locator | null> {
  const result: Locator[] = [];
  for (let i = 0; i < await locator.count(); i++) if (await locator.nth(i).isVisible().catch(() => false)) result.push(locator.nth(i));
  return result.length === 1 ? result[0] : null;
}
async function applyControl(page: Page, platform: Platform) {
  if (platform === 'linkedin') return unique(page.getByRole('button', { name: /^\s*Easy Apply(?:\s+to\b.*)?\s*$/i }));
  if (platform === 'hirist') {
    const tracked = await visible(page.locator('button[data-track="apply-job"]').filter({ hasText: APPLY }));
    if (tracked) return tracked;
  }
  if (platform === 'external') {
    const link = await unique(page.getByRole('link', { name: APPLY }));
    if (link) return link;
  }
  return unique(page.getByRole('button', { name: APPLY }).or(page.getByRole('link', { name: APPLY })));
}
async function snapshot(page: Page, platform: string, id: string, stage: string) {
  const dir = process.env.JOB_HUNTER_SNAPSHOTS ?? path.resolve(__dirname, '../../.cache/snapshots');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${platform}-${id.replace(/[^a-z0-9-]/gi, '').slice(0, 20)}-${stage}.html`), await page.content(), { mode: 0o600 });
}
async function titleMatches(page: Page, title: string, company?: string) {
  const titles = await page.locator('h1, h2.posting-headline, .posting-headline h2, [data-testid="job-title"], .job-title, [data-automation-id="jobPostingHeader"]').allInnerTexts();
  return titles.some((t) => key(t) === key(title) || !!company && key(t) === key(`${title} at ${company}`));
}
async function applicationRoot(page: Page) {
  return visible(page.locator('.jobs-easy-apply-modal, [role="dialog"]:has(button), .candidate-apply-modal, [data-automation-id="jobApplication"], [data-automation-id="applicationPage"], form:has(button), [class*="application-form" i]'));
}

/** Follow unique published links. A board Apply button may submit immediately and is never clicked to resolve a URL. */
async function resolveExternal(page: Page, title: string): Promise<Target | null> {
  for (let hop = 0; hop < 4; hop++) {
    const direct = atsTarget(page.url()); if (direct) return direct;
    if (!await titleMatches(page, title)) return null;
    const links = await page.locator('a[href], iframe[src]').evaluateAll((elements) => elements.filter((e) => e.tagName === 'IFRAME' || !!e.getClientRects().length && /^(apply(?: now| on company (?:site|website)| for this (?:job|position))?|continue to application)$/i.test((e.textContent || '').trim())).map((e) => e.getAttribute(e.tagName === 'IFRAME' ? 'src' : 'href')).filter(Boolean));
    const urls = [...new Set(links.flatMap((href) => { try { const url = new URL(href!, page.url()).href; return publicHttps(url) && !/\/(?:login|signin|authwall|checkpoint)(?:\/|\?|$)/.test(new URL(url).pathname) ? [url] : []; } catch { return []; } }))];
    const ats = urls.filter((url) => atsTarget(url));
    const next = ats.length === 1 ? ats[0] : urls.length === 1 ? urls[0] : null;
    if (!next || applicationUrlKey(next) === applicationUrlKey(page.url())) break;
    await page.goto(next, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(500);
    if (await pageInterruption(page)) return atsTarget(page.url());
  }
  if ((['linkedin', 'wellfound', 'hirist', 'instahyre'] as const).some((board) => boardJobId(page.url(), board))) return null;
  return await titleMatches(page, title) && (await readStep(page) || await applyControl(page, 'external')) ? { kind: 'custom', key: applicationUrlKey(page.url()) } : null;
}

/** Explicit applications through board dialogs and verified ATS/custom forms, with optional human handoffs. */
export async function applyPlatform(platform: Platform, initialPage: Page, job: Job, ctx: NaukriContext): Promise<NaukriResult> {
  let page = initialPage;
  const label = PLATFORM_NAMES[platform];
  const testUrl = (url: string) => !!ctx.allowTestUrl?.(url);
  const originalId = platform === 'external' ? null : boardJobId(job.url, platform);
  if ((!publicHttps(job.url) && !testUrl(job.url)) || (platform !== 'external' && !originalId && !testUrl(job.url))) return { status: 'external', note: `Not a supported ${label} job URL.` };
  let attempted = false, manualExposed = false, opportunityVerified = false;
  let target: Target | null = null;
  let applicationUrl = job.url;
  const stopped = (): NaukriResult => ({ status: attempted ? 'verification-required' : 'dry-run', note: attempted ? 'Stopped after an application action or manual handoff. Verify its status before retrying.' : 'Stopped before applying.' });
  const sameTarget = (url: string) => platform === 'external' ? target?.kind === 'custom' ? applicationUrlKey(url) === target.key : !!target && atsTarget(url)?.key === target.key && atsTarget(url)?.kind === target.kind : boardJobId(url, platform) === originalId;
  const sameJob = () => testUrl(page.url()) || sameTarget(page.url()) || platform === 'instahyre' && opportunityVerified && /^https:\/\/www\.instahyre\.com\/candidate\/opportunities\//.test(page.url());
  const unresolved = (status: 'needs-answers' | 'failed' | 'external', note: string): NaukriResult => ({ status: manualExposed ? 'verification-required' : status, note });
  function reserve() { ctx.beforeApply?.(applicationUrl); attempted = true; }
  async function ask(reason: HandoffReason, message: string) {
    if (!ctx.handoff || ctx.dryRun || ctx.signal?.aborted) return false;
    reserve(); manualExposed = true;
    const result = await ctx.handoff({ reason, message, url: page.url() });
    return result === 'resume' && !ctx.signal?.aborted;
  }
  async function confirmed() {
    if (!sameJob()) return false;
    if (platform === 'instahyre' && job.company) {
      const notice = await visible(page.locator('.candidate-apply-all-modal .modal-info-panel p'));
      if (notice && key(await notice.innerText()).startsWith(key(`Application sent to ${job.company}`) + ' there are')) return true;
    }
    const scope = platform === 'linkedin' || platform === 'wellfound' ? await applicationRoot(page) : null;
    const elements = (scope ?? page).locator('[role="status"], [role="alert"], .application-success, .success-message, .application-confirmation, [data-automation-id="applicationSubmitted"], h1, h2, h3');
    for (let i = 0; i < await elements.count(); i++) if (await elements.nth(i).isVisible().catch(() => false)) {
      const text = (await elements.nth(i).innerText()).trim();
      if (SUCCESS.test(text) || attempted && job.company && key(text) === key(`Your application was sent to ${job.company}`)) return true;
    }
    const applied = platform === 'linkedin' ? page.locator('.jobs-apply-button--applied, [data-control-name="view_application"]') : page.getByRole('button', { name: /^\s*(applied|interest shown|interested ✓|application sent)\s*$/i });
    return !!await visible(applied);
  }
  async function handleBlock() {
    for (let attempts = 0; attempts < 4; attempts++) {
      const blocked = await pageInterruption(page);
      if (!blocked) return true;
      if (!await ask(blocked.reason, blocked.message)) return false;
      if (!sameJob() && applicationUrlKey(page.url()) !== applicationUrlKey(applicationUrl) && !await pageInterruption(page)) await page.goto(applicationUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
    return !await pageInterruption(page);
  }
  async function waitForChange(signature?: string) {
    const until = Date.now() + (ctx.waitMs ?? 12000);
    while (Date.now() < until && !ctx.signal?.aborted) {
      if (!sameJob() || await confirmed() || await pageInterruption(page)) return;
      const step = await readStep(page);
      if (step && (!signature || step.signature !== signature)) return;
      const root = await applicationRoot(page);
      if (!step && root && await visible(root.getByRole('button', { name: NEXT }))) return;
      if (await visible(page.locator('[role="alert"], .error-message, .field-error'))) return;
      await page.waitForTimeout(200);
    }
  }
  try {
    if (ctx.signal?.aborted) return stopped();
    ctx.progress?.(`Opening ${label} application.`);
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(ctx.waitMs === undefined ? 1500 : 20);
    const readyBy = Date.now() + (ctx.waitMs ?? 12000);
    while (Date.now() < readyBy && !ctx.signal?.aborted) {
      if (await pageInterruption(page) || await titleMatches(page, job.title, job.company) || await applyControl(page, platform)) break;
      await page.waitForTimeout(200);
    }
    if (!await handleBlock()) return ctx.signal?.aborted ? stopped() : unresolved('failed', 'Login or browser check requires your input. No automatic retry will be made after a manual handoff.');
    if (platform === 'external') {
      target = await resolveExternal(page, job.title);
      if (target) applicationUrl = page.url();
      if (!await handleBlock()) return unresolved('failed', 'Complete the company login or browser check in Chrome.');
      if (!target) target = await resolveExternal(page, job.title);
      if (!target && !testUrl(page.url()) && await ask('form', 'Open the intended company application or saved draft in Chrome, verify the job, then continue here. This page has no application form the app can identify yet.')) target = await resolveExternal(page, job.title);
      if (!target && !testUrl(page.url())) return unresolved('external', 'No unique application destination or supported form could be verified. Open this posting manually.');
      const expected = atsTarget(job.url);
      if (expected && target && (expected.kind !== target.kind || expected.key !== target.key)) return { status: attempted ? 'verification-required' : 'no-button', note: 'The company portal redirected to a different posting. The saved job was not applied to.' };
      applicationUrl = page.url();
      if (target?.kind === 'custom' && new URL(applicationUrl).hostname !== new URL(job.url).hostname && !companyHost(applicationUrl, job.companyDomain)) {
        if (!await ask('destination', 'Review this company application destination in Chrome, confirm it is the intended job, then continue here.')) return unresolved('external', 'The custom application destination needs your review.');
      }
    }
    if (!sameJob()) return { status: manualExposed ? 'verification-required' : 'no-button', note: 'The original job redirected to another posting or listing. Refresh this job before applying.' };
    if (await confirmed()) return { status: attempted ? 'applied' : 'already-applied', note: `${label} shows this application as submitted.` };
    if (!await titleMatches(page, job.title, job.company)) return { status: 'no-button', note: 'The job title could not be matched to the saved posting. Refresh the job before applying.' };
    const initialText = await page.locator('body').innerText();
    if (/no longer accepting|job (?:has )?expired|position (?:has been )?closed|job listing is no longer available/i.test(initialText)) return { status: 'no-button', note: 'This job is closed.' };
    if (/you(?:'|’)?ve reached.*(?:easy apply|application) limit|easy apply limit|too many requests/i.test(initialText)) return unresolved('failed', 'The site application limit was reached. Wait for the site to allow applications again.');
    const initialStep = platform === 'external' ? await readStep(page) : null;
    let button = await applyControl(page, platform);
    if (platform === 'linkedin' && !button && await visible(page.getByRole('link', { name: /^Sign in$/i }))) {
      if (!await ask('login', 'Sign in to LinkedIn in Chrome and return to this job, then continue here.')) return unresolved('failed', 'LinkedIn login is required for Easy Apply. Use Setup to sign in.');
      if (!sameJob()) await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (await confirmed()) return { status: 'applied' };
      button = await applyControl(page, platform);
    }
    if (platform === 'instahyre' && !button && originalId) {
      ctx.progress?.('Locating the exact Instahyre job in your Opportunities search.');
      opportunityVerified = await openInstahyreOpportunity(page, job, originalId, ctx.signal);
      if (!opportunityVerified) return { status: 'no-button', note: 'This exact job was not available in your candidate Opportunities search. No application was sent.' };
      if (await confirmed()) return { status: 'already-applied' };
      button = await applyControl(page, platform);
    }
    if (!initialStep && !button) return platform === 'linkedin' ? { status: 'external', note: 'No Easy Apply control. Use Company websites for employer-site applications.' } : { status: 'no-button', note: 'No single supported Apply control was found. Open this job in Chrome to review it.' };
    if (ctx.dryRun) { await snapshot(page, platform, job.id, 'check'); return { status: 'dry-run', note: `${label} job and ${initialStep ? 'application form' : 'Apply control'} verified. No application was sent.` }; }
    if (!initialStep && button) {
      if (ctx.signal?.aborted) return stopped();
      const href = await button.getAttribute('href');
      const destination = href ? new URL(href, page.url()).href : null;
      if (destination && !sameTarget(destination)) return { status: 'external', note: 'Apply continues on another website. Use Company websites for this application.' };
      if (platform === 'external' && destination) await page.goto(destination, { waitUntil: 'domcontentloaded', timeout: 45000 });
      else {
        reserve();
        const popup = page.waitForEvent('popup', { timeout: ctx.waitMs ?? 1200 }).catch(() => null);
        await button.click({ timeout: 10000 });
        const opened = await popup;
        if (opened) { page = opened; await page.waitForLoadState('domcontentloaded', { timeout: 15000 }); }
      }
      await waitForChange();
    }
    for (let number = 0; number < 30; number++) {
      if (ctx.signal?.aborted) return stopped();
      if (!await handleBlock()) return unresolved(attempted ? 'needs-answers' : 'failed', 'Login or verification still needs your input.');
      if (!sameJob()) {
        if (await ask('destination', 'The application moved away from the verified posting. Verify the destination and intended job in Chrome, then continue.')) {
          if (platform === 'external' && target?.kind === 'custom' && publicHttps(page.url()) && await titleMatches(page, job.title, job.company) && !(['linkedin', 'wellfound', 'hirist', 'instahyre'] as const).some((board) => boardJobId(page.url(), board))) {
            target = atsTarget(page.url()) ?? { kind: 'custom', key: applicationUrlKey(page.url()) };
            applicationUrl = page.url(); reserve();
          }
          continue;
        }
        return { status: attempted ? 'verification-required' : 'external', note: 'Application navigated away from the verified posting. Check its status before retrying.' };
      }
      if (await confirmed()) { await snapshot(page, platform, job.id, 'confirmation'); return { status: 'applied', note: `${label} confirmed the application.` }; }
      const text = await page.locator('body').innerText();
      if (/you(?:'|’)?ve reached.*(?:easy apply|application) limit|easy apply limit|too many requests|daily application limit/i.test(text)) return { status: attempted ? 'verification-required' : 'failed', note: 'The site application limit was reached. Stop this run and wait for the site to allow applications again.' };
      const bulk = await visible(page.locator('.candidate-apply-all-modal, [role="dialog"], .modal'));
      if (bulk && /apply to (?:all|similar|other|more)|other (?:matching )?(?:jobs|companies)|bulk apply|select all|multiple (?:jobs|companies)/i.test(await bulk.innerText())) return { status: attempted ? 'verification-required' : 'needs-answers', note: 'A bulk or additional-company application dialog needs manual review. No additional jobs were selected.' };
      const root = await applicationRoot(page);
      if (platform === 'linkedin' && root) {
        const follow = root.getByRole('checkbox', { name: /^Follow\b/i });
        for (let i = 0; i < await follow.count(); i++) if (await follow.nth(i).isChecked()) await follow.nth(i).uncheck({ timeout: 3000 });
      }
      const manualStart = platform === 'external' && target?.kind === 'workday' ? await unique(page.getByRole('button', { name: /^Apply manually$/i })) : null;
      if (manualStart) { reserve(); await manualStart.click({ timeout: 5000 }); await waitForChange(); continue; }
      const step = await readStep(page);
      if (step) {
        await snapshot(page, platform, job.id, `step-${number}`);
        for (const field of step.fields) {
          if (platform === 'external' || platform === 'linkedin' || platform === 'wellfound') {
            const control = step.root.locator(`[data-job-hunter-field="${field.id}"]`).first();
            field.required = !!await control.evaluate((element) => element.hasAttribute('required') || element.getAttribute('aria-required') === 'true' || !!element.closest('.required, [data-required="true"]')) || /\*|\brequired\b/i.test(field.label);
          }
          if (field.kind === 'manual' && /\b(resume|cv|curriculum vitae)\b/i.test(field.label) && ctx.resumeFile) {
            const input = step.root.locator(`[data-job-hunter-field="${field.id}"]`);
            if (await input.getAttribute('type') === 'file') { await input.setInputFiles(ctx.resumeFile, { timeout: 5000 }); field.value = path.basename(ctx.resumeFile); }
          }
        }
        const result = await stepAnswers(step.fields.filter((f) => !f.value), ctx);
        ctx.progress?.(`${label} screening step ${number + 1}`, result.answers);
        const missing = result.answers.filter((a) => a.value === null && step.fields.find((f) => f.id === a.id)?.required !== false);
        if (missing.length) {
          for (const answer of missing) if (answer.canSave) rememberQuestion(answer.label, label, job.title);
          const message = missing.map((a) => `${a.label}: ${a.reason}`).join('; ').slice(0, 1500);
          if (await ask('answers', message + ' Complete these fields in Chrome or save confirmed answers here, then continue.')) continue;
          return unresolved('needs-answers', message);
        }
        let filled = true;
        for (const answer of result.answers) if (answer.value !== null) {
          if (ctx.signal?.aborted) return stopped();
          try { await fillField(step, step.fields.find((f) => f.id === answer.id)!, answer.value, ctx); }
          catch (error) {
            if (!(error instanceof NaukriAnswerError)) throw error;
            rememberQuestion(answer.label, label, job.title); filled = false;
            if (await ask('form', `${answer.label}: ${error.message} Select it in Chrome, then continue.`)) break;
            return unresolved('needs-answers', `${answer.label}: ${error.message}`);
          }
        }
        if (!filled) continue;
      }
      const scope = step?.root ?? root;
      const next = scope ? await unique(scope.getByRole('button', { name: NEXT })) : null;
      if (!next || await next.isDisabled()) {
        if (await ask('form', 'This application needs a custom control, required declaration or additional details. Complete the visible step in Chrome, then continue here.')) continue;
        if (attempted && !step) return { status: 'verification-required', note: 'Apply was clicked but there is no verifiable form or completion. Check the application before retrying.' };
        return unresolved('needs-answers', 'The form needs a manual control or an answer failed validation. Review it in Chrome.');
      }
      if (ctx.signal?.aborted) return stopped();
      reserve(); await next.click({ timeout: 10000 }); await waitForChange(step?.signature);
      if (await confirmed()) continue;
      const error = scope ? await visible(scope.locator('[role="alert"], .error-message, .field-error, [data-automation-id="errorMessage"]')) : null;
      if (error) {
        const message = `Form validation: ${(await error.innerText()).slice(0, 500)}`;
        if (await ask('form', message + ' Correct it in Chrome, then continue.')) continue;
        return unresolved('needs-answers', message);
      }
      if (step && (await readStep(page))?.signature === step.signature && !await pageInterruption(page)) {
        if (await ask('form', 'The step did not advance. Check its validation in Chrome and continue when ready.')) continue;
        break;
      }
    }
    await snapshot(page, platform, job.id, 'unconfirmed');
    return { status: attempted ? 'verification-required' : 'needs-answers', note: attempted ? 'An application action was clicked, but no confirmation was verified. This job will not be retried automatically.' : 'This application needs manual review.' };
  } catch (error) {
    if (ctx.signal?.aborted) return stopped();
    return { status: attempted ? 'verification-required' : 'failed', note: (error as Error).message.split('\n')[0] };
  }
}
