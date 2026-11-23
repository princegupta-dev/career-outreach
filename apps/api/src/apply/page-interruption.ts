import type { Locator, Page } from 'playwright';
import type { HandoffReason } from './handoff';

async function visible(locator: Locator) {
  for (let i = 0; i < await locator.count(); i++) if (await locator.nth(i).isVisible().catch(() => false)) return true;
  return false;
}
export async function pageInterruption(page: Page): Promise<{ reason: HandoffReason; message: string } | null> {
  const title = await page.title();
  if (/captcha|access denied|just a moment|security check|verify (?:you|your identity)/i.test(title) || /\/(?:checkpoint|challenge)(?:\/|\?|$)/.test(page.url()) || await visible(page.locator('iframe[src*="recaptcha"]:not([title*="invisible" i]), iframe[src*="hcaptcha"], [data-testid="captcha"], [data-automation-id="captcha"]'))) return { reason: 'captcha', message: 'Complete the browser verification or CAPTCHA yourself in Chrome, then continue here.' };
  if (/log ?in|sign ?in|create (?:an? )?account/i.test(title) || /\/(?:login|signin|sign-in|authwall)(?:\/|\?|$)/i.test(page.url()) || await visible(page.locator('input[type="password"]'))) return { reason: 'login', message: 'Sign in or create the required candidate account yourself in Chrome, then return to this job and continue here. Passwords are never read or filled by the app.' };
  return null;
}
