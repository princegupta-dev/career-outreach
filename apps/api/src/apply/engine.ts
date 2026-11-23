import type { Page } from 'playwright';
import type { Answer } from './answers';
import type { ApplyStatus } from './log';
import { applyNaukri } from './naukri';
import { loadProfile } from '../search';
import { readResume, RESUME_TEXT_FILE } from '../discover/insights';
import type { CandidateProfile } from '../domain/profile/profile';
import { applyPlatform } from './platform-engine';

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
  profile?: CandidateProfile;
  resumeText?: string;
  beforeApply?: () => void;
  allowTestUrl?: (url: string) => boolean;
  waitMs?: number;
}

export async function applyOnSite(page: Page, site: ApplySite, job: { id: string; url: string; title: string; company?: string }, ctx: ApplyContext): Promise<ApplyResult> {
  const context = { profile: ctx.profile ?? loadProfile(), answers: ctx.answers, resumeText: ctx.resumeText ?? readResume(RESUME_TEXT_FILE), dryRun: ctx.dryRun, beforeApply: ctx.beforeApply, allowTestUrl: ctx.allowTestUrl, waitMs: ctx.waitMs };
  return site.key === 'naukri' ? applyNaukri(page, job, context) : applyPlatform(site.key, page, job, context);
}
