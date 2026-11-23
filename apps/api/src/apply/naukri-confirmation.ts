import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import type { Page } from 'playwright';
import { loadLog, record, type ApplyEntry } from './log';

const normalize = (value: string) => value.toLowerCase().replace(/["“”'‘’]/g, '').replace(/\s+/g, ' ').trim();
export function confirmationTitle(html: string): string | null {
  const $ = cheerio.load(html);
  const heading = $('.acp-header-container .job-title-text').first();
  if (!/^applied to\b/i.test(heading.text().trim())) return null;
  return heading.find('.job-title').text().replace(/^["“]|["”]$/g, '').trim() || null;
}
export function confirmsJob(html: string, title: string): boolean {
  const applied = confirmationTitle(html);
  return applied !== null && normalize(applied) === normalize(title);
}
export async function hasNaukriConfirmation(page: Page, title: string): Promise<boolean> {
  const heading = page.locator('.acp-header-container .job-title-text').first();
  if (!(await heading.isVisible().catch(() => false))) return false;
  const text = (await heading.innerText()).trim();
  return /^applied to\b/i.test(text) && normalize(text.replace(/^applied to\s*/i, '')) === normalize(title);
}

/** Repair a failed result only when its own saved confirmation explicitly names the same job. */
export function reconcileNaukriConfirmations(logFile?: string, snapshots = process.env.JOB_HUNTER_SNAPSHOTS ?? path.resolve(__dirname, '../../.cache/snapshots')): ApplyEntry[] {
  const repaired: ApplyEntry[] = [];
  for (const entry of Object.values(loadLog(logFile))) {
    if (!entry.url.includes('naukri.com') || entry.status === 'applied' || entry.status === 'already-applied') continue;
    const prefix = entry.jobId.slice(0, 10);
    for (const name of [`apply-naukri-${prefix}-after-click.html`, `naukri-${prefix}-after-click.html`]) {
      try {
        if (!confirmsJob(fs.readFileSync(path.join(snapshots, name), 'utf8'), entry.title)) continue;
        const corrected: ApplyEntry = { ...entry, status: 'applied', note: 'Verified from the saved Naukri confirmation for this exact job.' };
        record(corrected, logFile); repaired.push(corrected); break;
      } catch { /* no trustworthy confirmation for this attempt */ }
    }
  }
  return repaired;
}
