/* eslint-disable no-console -- terminal output is this file's job */
import * as readline from 'readline';
import { openBrowser, PROFILE_DIR } from './browser/runner';
import { SITES, sitesByKey } from './browser/sites';

/**
 * `npm run login -- linkedin naukri` — opens your Chrome on each login page. You log in yourself
 * (password, OTP, captcha), then press Enter in the terminal. The session is saved in PROFILE_DIR on this machine only.
 * (Closing the window is not enough on macOS: Chrome keeps running. Enter lets Chrome shut down cleanly and save cookies.)
 */
async function main(): Promise<void> {
  const keys = process.argv.slice(2);
  if (!keys.length) {
    console.log(`Usage: npm run login -- <site...>\nSites: ${SITES.map((s) => s.key).join(', ')}`);
    return;
  }
  const sites = sitesByKey(keys);
  const ctx = await openBrowser(false);
  const opened: string[] = [];
  for (const s of sites) {
    const page = await ctx.newPage();
    try {
      await page.goto(s.loginUrl);
      opened.push(s.name);
    } catch (e) {
      await page.close();
      const msg = (e as Error).message.split('\n')[0];
      // A certificate error means the connection is not safe to type a password into. Never bypass it.
      console.log(`✗ ${s.name}: ${msg}`);
      if (/CERT/.test(msg)) console.log('  Do NOT log in to this site on this network: something is intercepting the HTTPS connection.');
    }
  }
  if (!opened.length) {
    await ctx.close();
    process.exitCode = 1;
    return;
  }
  console.log(`Log in to ${opened.join(', ')} in the Chrome window.\nWhen you are done, come back here and press Enter.\nSession folder: ${PROFILE_DIR}`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => {
    rl.question('', () => resolve());
    ctx.on('close', () => resolve()); // also fine if the browser was quit (Cmd+Q)
  });
  rl.close();
  await ctx.close().catch(() => undefined);
  console.log('Saved. Now run: npm run fetch -- 7 --sites=' + keys.join(','));
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
