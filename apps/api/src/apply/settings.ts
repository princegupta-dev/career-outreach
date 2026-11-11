import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ApplySite } from './engine';

/**
 * Your switch for auto-apply, per site: "off", "dry-run" (everything but the final click) or "on".
 * Every site starts in dry-run. Switching a site to "on" is your approval for the daily run to apply there.
 */
export const SETTINGS_FILE = process.env.JOB_HUNTER_SETTINGS ?? path.join(os.homedir(), '.job-hunter', 'settings.json');

export type Mode = 'off' | 'dry-run' | 'on';
export interface ApplySettings {
  autoApply: Record<ApplySite['key'], Mode>;
  minScore: number;
  maxPerRun: number;
  /** Days back to look for new jobs in the daily run. */
  days: number;
}

export const DEFAULT_SETTINGS: ApplySettings = {
  autoApply: { naukri: 'dry-run', hirist: 'dry-run', instahyre: 'dry-run' },
  minScore: 70,
  maxPerRun: 15,
  days: 3,
};

const MODES: Mode[] = ['off', 'dry-run', 'on'];

/** Reads your settings (creating the file on first use). Unknown or broken values fall back to the safe default. */
export function loadSettings(file = SETTINGS_FILE): ApplySettings {
  let raw: Partial<ApplySettings> = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ApplySettings>;
  } catch {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(DEFAULT_SETTINGS, null, 2));
  }
  const autoApply = { ...DEFAULT_SETTINGS.autoApply };
  for (const k of Object.keys(autoApply) as ApplySite['key'][]) {
    const m = raw.autoApply?.[k];
    if (m && MODES.includes(m)) autoApply[k] = m;
  }
  const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && v >= lo && v <= hi ? v : d);
  return {
    autoApply,
    minScore: num(raw.minScore, DEFAULT_SETTINGS.minScore, 0, 100),
    maxPerRun: num(raw.maxPerRun, DEFAULT_SETTINGS.maxPerRun, 1, 30),
    days: num(raw.days, DEFAULT_SETTINGS.days, 1, 30),
  };
}
