import * as fs from 'fs';
import * as path from 'path';
import type { Locator, Page } from 'playwright';
import { Answer, matchAnswer, pickOption, rememberQuestion } from './answers';
import type { ApplyStatus } from './log';

/**
 * Apply to one job in your logged-in Chrome, on any supported site.
 * Buttons are found by their visible name (what you see on screen), not by CSS classes, so small redesigns do not
 * break it. Each site's names come from what the site shows; check them with a dry run before real use.
 */
export interface ApplySite {
  key: 'naukri' | 'hirist' | 'instahyre';
  name: string;
  apply: RegExp;
  already: RegExp;
  external?: RegExp;
  success: RegExp;
  /** Element ids/selectors the site uses for these controls, tried before matching by name. */
  ids?: { apply?: string; already?: string; external?: string };
}

export const APPLY_SITES: Record<ApplySite['key'], ApplySite> = {
  naukri: {
    key: 'naukri',
    name: 'Naukri',
    apply: /^\s*(apply|apply now|easy apply|quick apply)\s*$/i,
    already: /^\s*applied\s*$/i,
    external: /apply on company (site|website)|company site/i,
    success: /successfully applied|you have applied|applied successfully|application (has been )?(sent|submitted)/i,
    // Seen on real Naukri job pages (Nov 2026): <span id="already-applied">Applied</span> inside the apply area.
    ids: { apply: '#apply-button', already: '#already-applied', external: '#company-site-button' },
  },
  hirist: {
    key: 'hirist',
    name: 'Hirist',
    apply: /^\s*(apply|apply now|quick apply)\s*$/i,
    already: /^\s*applied\s*$/i,
    success: /successfully applied|applied successfully|application (has been )?(sent|submitted)|you have applied/i,
  },
  instahyre: {
    key: 'instahyre',
    name: 'Instahyre',
    apply: /^\s*(apply|apply now|i'?m interested|interested)\s*$/i,
    already: /^\s*(applied|interest shown|interested ✓)\s*$/i,
    success: /successfully applied|application (sent|submitted)|interest (sent|shown)|you have applied/i,
  },
};

/** Which site applies to a job, from the job's source on the dashboard. */
export const SITE_FOR_SOURCE: Record<string, ApplySite['key']> = { NAUKRI: 'naukri', HIRIST: 'hirist', INSTAHYRE: 'instahyre' };

export interface ApplyResult {
  status: ApplyStatus;
  note?: string;
}

export interface ApplyContext {
  answers: Answer[];
  /** Your strong skills: experience questions about anything else are never answered for you. */
  strongSkills: string[];
  dryRun: boolean;
}

const WALL = /login|sign in|captcha|access denied|just a moment/i;
const NEXT = /^\s*(save|submit|next|continue|send|done|apply)\s*$/i;
/** Read when used (not at import), so tests can point it at a temp folder. */
const snapshotDir = () => process.env.JOB_HUNTER_SNAPSHOTS ?? path.resolve(__dirname, '../../.cache/snapshots');

async function visible(l: Locator): Promise<Locator | null> {
  const n = await l.count();
  for (let i = 0; i < n; i++) if (await l.nth(i).isVisible().catch(() => false)) return l.nth(i);
  return null;
}

async function snapshot(page: Page, site: string, name: string): Promise<void> {
  fs.mkdirSync(snapshotDir(), { recursive: true });
  fs.writeFileSync(path.join(snapshotDir(), `apply-${site}-${name}.html`), await page.content());
}

/** The question dialog/drawer shown after Apply, if any. */
async function questionBox(page: Page): Promise<Locator | null> {
  return visible(
    page
      .locator('[role="dialog"], [class*="chatbot" i], [class*="drawer" i], [class*="modal" i], [class*="questionnaire" i]')
      .filter({ has: page.locator('input, textarea, select, [contenteditable="true"], [role="radio"], [role="option"]') }),
  );
}

/** Answer one question in the box: a text box, a dropdown, or a set of options (radio buttons / chips). */
async function fill(box: Locator, answer: string): Promise<boolean> {
  const select = await visible(box.locator('select'));
  if (select) {
    const labels = (await select.locator('option').allInnerTexts()).map((t) => t.trim());
    const i = pickOption(labels, answer);
    if (i < 0) return false;
    await select.selectOption({ label: labels[i] });
    return true;
  }
  const choices = box.locator('label:has(input[type="radio"]), label:has(input[type="checkbox"]), [role="radio"], [role="option"], [class*="chip" i], [class*="option" i]');
  const texts = (await choices.allInnerTexts()).map((t) => t.trim());
  if (texts.filter(Boolean).length >= 2) {
    const i = pickOption(texts, answer);
    if (i < 0) return false;
    await choices.nth(i).click();
    return true;
  }
  const input = await visible(box.locator('textarea, input[type="text"], input:not([type]), input[type="number"], input[type="tel"], input[type="email"], input[type="url"], [contenteditable="true"]'));
  if (!input) return false;
  const type = (await input.getAttribute('type')) ?? '';
  // A number-only field gets the number part ("30 days" → 30); a range like "12-14 LPA" cannot be typed there.
  const value = type === 'number' || type === 'tel' ? answer.match(/^\d+(\.\d+)?/)?.[0] : answer;
  if (!value || (type === 'number' && /^\d+(\.\d+)?\s*-\s*\d/.test(answer))) return false;
  await input.click();
  await input.fill(value).catch(async () => input.pressSequentially(value, { delay: 60 }));
  return true;
}

/**
 * Answer questions one at a time, from saved answers only. A question nothing can answer is saved to your
 * unanswered list and the application stops there (status needs-answers).
 */
async function answerQuestions(page: Page, site: ApplySite, job: { id: string; title: string }, ctx: ApplyContext): Promise<ApplyResult | null> {
  for (let step = 0; step < 15; step++) {
    if (site.success.test(await page.locator('body').innerText().catch(() => ''))) return { status: 'applied' };
    const box = await questionBox(page);
    if (!box) return null;
    await snapshot(page, site.key, `${job.id.slice(0, 10)}-question-${step}`);
    const lines = (await box.innerText()).split('\n').map((l) => l.trim()).filter(Boolean);
    // The question is the last line ending in "?"; otherwise the first line (options and buttons come after it).
    const question = [...lines].reverse().find((l) => l.endsWith('?')) ?? lines[0] ?? '';
    const answer = matchAnswer(question, ctx.answers, ctx.strongSkills);
    if (!answer) {
      rememberQuestion(question, site.name, job.title);
      return { status: 'needs-answers', note: `No saved answer for: "${question.slice(0, 120)}" (added to npm run answers)` };
    }
    if (!(await fill(box, answer))) {
      rememberQuestion(question, site.name, job.title);
      return { status: 'needs-answers', note: `Answer "${answer}" does not fit the options for: "${question.slice(0, 100)}"` };
    }
    const next = await visible(box.getByRole('button', { name: NEXT }));
    if (next) await next.click();
    else await box.locator('textarea, input').first().press('Enter').catch(() => undefined);
    await page.waitForTimeout(2500);
  }
  return { status: 'needs-answers', note: 'Too many questions' };
}

export async function applyOnSite(page: Page, site: ApplySite, job: { id: string; url: string; title: string }, ctx: ApplyContext): Promise<ApplyResult> {
  const id = job.id.slice(0, 10);
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(3000);
  if (WALL.test(await page.title()) || /nlogin|\/login/.test(page.url())) return { status: 'failed', note: `Not logged in to ${site.name}. Run: npm run login -- ${site.key}` };
  if (ctx.dryRun) await snapshot(page, site.key, `${id}-job`);

  // "Applied" is often a plain label, not a button: look for the site's id, a button, or any element saying exactly that.
  const already = page.getByRole('button', { name: site.already }).or(page.getByText(site.already));
  if (await visible(site.ids?.already ? page.locator(site.ids.already).or(already) : already)) return { status: 'already-applied' };
  const byName = page.getByRole('button', { name: site.apply }).or(page.getByRole('link', { name: site.apply }));
  const apply = await visible(site.ids?.apply ? page.locator(site.ids.apply).or(byName) : byName);
  if (!apply) {
    const extByName = site.external ? page.getByRole('button', { name: site.external }).or(page.getByRole('link', { name: site.external })) : null;
    const external = extByName ? await visible(site.ids?.external ? page.locator(site.ids.external).or(extByName) : extByName) : null;
    return external ? { status: 'external', note: 'Applies on the company website' } : { status: 'no-button', note: 'No Apply button (closed job, or the page changed)' };
  }
  if (ctx.dryRun) return { status: 'dry-run', note: 'Apply button found; not clicked' };

  await apply.click();
  await page.waitForTimeout(3000);
  const answered = await answerQuestions(page, site, job, ctx);
  if (answered) return answered;
  if (site.success.test(await page.locator('body').innerText().catch(() => ''))) return { status: 'applied' };
  if (await visible(page.getByRole('button', { name: site.already }).or(page.getByText(site.already)))) return { status: 'applied' };
  await snapshot(page, site.key, `${id}-after-click`);
  return { status: 'failed', note: 'Clicked Apply but saw no confirmation; check the job on the site (snapshot saved)' };
}
