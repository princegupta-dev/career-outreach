import type { Locator, Page } from 'playwright';

const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
async function visible(locator: Locator) {
  for (let i = 0; i < await locator.count(); i++) if (await locator.nth(i).isVisible()) return locator.nth(i);
  return null;
}

/** Instahyre public postings are read-only. Locate the exact job id in candidate search, then use View job. */
export async function openInstahyreOpportunity(page: Page, job: { title: string; company?: string }, id: string, signal?: AbortSignal) {
  await page.goto('https://www.instahyre.com/candidate/opportunities/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (signal?.aborted) return false;
  const input = page.locator('input#skills-drop-select-job-search-selectized');
  await input.waitFor({ state: 'visible', timeout: 15000 });
  await input.pressSequentially(job.title.slice(0, 150), { delay: 15 });
  const dropdown = page.locator('.selectize-dropdown').filter({ visible: true });
  const exact = dropdown.locator('[data-selectable][data-value]').filter({ hasText: new RegExp(`^\\s*${job.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i') });
  const option = await visible(exact) ?? await visible(dropdown.locator('.create[data-selectable]'));
  if (!option || signal?.aborted) return false;
  await option.click({ timeout: 3000 });
  await page.getByRole('button', { name: 'Search', exact: true }).click({ timeout: 5000 });
  await page.locator('a#employer-profile-opportunity').filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => undefined);
  if (signal?.aborted) return false;
  const cards = page.locator('a#employer-profile-opportunity').filter({ has: page.locator(`[id="job-skills-${id}"]`), visible: true });
  if (!await cards.count() && job.company) {
    const companyInput = page.locator('input#companies-selectized');
    if (await companyInput.isVisible()) {
      await companyInput.pressSequentially(job.company, { delay: 15 });
      const choice = page.locator('.selectize-dropdown').filter({ visible: true }).getByText(job.company, { exact: true });
      if (await choice.count() === 1 && await choice.isVisible()) {
        await choice.click({ timeout: 3000 });
        await cards.first().waitFor({ state: 'visible', timeout: 12000 }).catch(() => undefined);
      }
    }
  }
  if (signal?.aborted || await cards.count() !== 1) return false;
  const heading = await cards.locator('.employer-job-name').getAttribute('title');
  if (!heading || key(heading) !== key(`${job.company} - ${job.title}`)) return false;
  await cards.getByRole('button', { name: /View job/i }).click({ timeout: 5000 });
  const modal = page.locator('.candidate-apply-modal').filter({ visible: true });
  await modal.locator('h1').waitFor({ state: 'visible', timeout: 10000 });
  return key(await modal.locator('h1').innerText()) === key(job.title) && !!job.company && key(await modal.locator('h2.company-name').innerText()) === key(job.company);
}
