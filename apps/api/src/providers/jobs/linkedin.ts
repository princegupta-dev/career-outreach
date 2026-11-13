import * as cheerio from 'cheerio';
import type { ContactCandidate } from '../../types';
import { httpFetch } from '../http';
import { extractEmails } from './emails';
import { htmlToText } from './html-extract';
import { filterListed, JobProvider, JobSearchCriteria, parseDate, ProviderJob, warn } from './job-provider.interface';

/**
 * LinkedIn's public job search: the pages anyone sees without signing in. No login, so your account is never involved.
 *   list:   /jobs-guest/jobs/api/seeMoreJobPostings/search  (10 jobs per page; f_TPR = posted within N seconds)
 *   detail: /jobs-guest/jobs/api/jobPosting/{id}            (full description, seniority, type, sometimes the poster)
 * Kept gentle on purpose: a few pages per run and a pause between requests.
 */
const BASE = 'https://www.linkedin.com/jobs-guest/jobs/api';
export const LINKEDIN_KEYWORDS = ['node.js backend developer', 'backend engineer', 'nestjs developer'];
const PAGES = 2;
const MAX_DETAILS = 40;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface LinkedInCard {
  id: string;
  title: string;
  company: string;
  location: string;
  postedAt: Date | null;
  url: string;
}

/** Job cards from a public search results page. */
export function parseLinkedInList(html: string): LinkedInCard[] {
  const $ = cheerio.load(html);
  const out: LinkedInCard[] = [];
  $('.base-card, .job-search-card').each((_, el) => {
    const card = $(el);
    const id = (card.attr('data-entity-urn') ?? card.find('[data-entity-urn]').attr('data-entity-urn') ?? '').match(/jobPosting:(\d+)/)?.[1];
    const title = card.find('.base-search-card__title').first().text().trim();
    const company = card.find('.base-search-card__subtitle').first().text().trim();
    if (!id || !title || !company) return;
    out.push({
      id,
      title,
      company,
      location: card.find('.job-search-card__location').first().text().trim(),
      postedAt: parseDate(card.find('time').attr('datetime')),
      url: `https://www.linkedin.com/jobs/view/${id}`,
    });
  });
  // The same job can appear twice on a page (e.g. promoted): keep the first.
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

/** Description, criteria and (when shown) the person who posted the job, from a public job page. */
export function parseLinkedInDetail(html: string): { description: string; criteria: Record<string, string>; poster: { name: string; url: string | null; headline: string } | null } {
  const $ = cheerio.load(html);
  const description = htmlToText($('.show-more-less-html__markup').first().html() ?? $('.description__text').first().html() ?? '');
  const criteria: Record<string, string> = {};
  $('.description__job-criteria-item').each((_, el) => {
    const k = $(el).find('.description__job-criteria-subheader').text().trim();
    const v = $(el).find('.description__job-criteria-text').text().trim();
    if (k && v) criteria[k] = v;
  });
  const box = $('.message-the-recruiter').first();
  const name = box.find('.base-main-card__title').first().text().trim();
  const poster = name ? { name, url: box.find('a.base-card__full-link, a').first().attr('href')?.split('?')[0] ?? null, headline: box.find('.base-main-card__subtitle').first().text().trim() } : null;
  return { description, criteria, poster };
}

export class LinkedInProvider implements JobProvider {
  readonly kind = 'LINKEDIN' as const;

  supportsUrl(url: string): boolean {
    return /linkedin\.com\/jobs\/view\//.test(url);
  }

  async getJob(): Promise<ProviderJob | null> {
    return null;
  }

  async searchJobs(criteria: JobSearchCriteria, config: Record<string, unknown>): Promise<ProviderJob[]> {
    const days = criteria.postedWithinDays ?? 7;
    const delay = typeof config.delayMs === 'number' ? config.delayMs : 1500;
    const keywords = (config.keywords as string[] | undefined) ?? LINKEDIN_KEYWORDS;
    const cards = new Map<string, LinkedInCard>();
    for (const k of keywords) {
      for (let page = 0; page < PAGES; page++) {
        const url = `${BASE}/seeMoreJobPostings/search?keywords=${encodeURIComponent(k)}&location=India&f_TPR=r${days * 86_400}&sortBy=DD&start=${page * 10}`;
        const r = await httpFetch(url, { headers: { Accept: 'text/html' }, retries: 1 });
        if (r.status === 429 || r.status === 999) {
          warn(criteria, `LinkedIn asked us to slow down (HTTP ${r.status}); stopped early`);
          break;
        }
        const found = r.status === 200 ? parseLinkedInList(r.text) : [];
        found.forEach((c) => cards.set(c.id, c));
        await pause(delay);
        if (found.length < 10) break;
      }
    }

    const shallow: ProviderJob[] = [...cards.values()].map((c) => ({
      provider: 'LINKEDIN',
      externalId: c.id,
      url: c.url,
      title: c.title,
      companyName: c.company,
      location: c.location || null,
      remote: /remote/i.test(c.location) ? true : null,
      description: '',
      postedAt: c.postedAt,
    }));
    const candidates = filterListed(shallow, criteria).slice(0, MAX_DETAILS);

    const out: ProviderJob[] = [];
    let failed = 0;
    for (const c of candidates) {
      try {
        const r = await httpFetch(`${BASE}/jobPosting/${c.externalId}`, { headers: { Accept: 'text/html' }, retries: 1 });
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        const d = parseLinkedInDetail(r.text);
        const contacts: ContactCandidate[] = [
          ...extractEmails(d.description).map((email) => ({ name: email, email, roleCategory: 'RECRUITER' as const, source: 'linkedin-description', sourceUrl: c.url, confidence: 'VERIFIED' as const })),
          ...(d.poster ? [{ name: d.poster.name, role: d.poster.headline || null, linkedinUrl: d.poster.url, roleCategory: 'RECRUITER' as const, source: 'linkedin-job-poster', sourceUrl: c.url, confidence: 'VERIFIED' as const }] : []),
        ];
        out.push({
          ...c,
          description: d.description,
          employmentType: d.criteria['Employment type'] ?? null,
          contacts,
          flags: d.criteria['Seniority level'] ? [`linkedin-seniority:${d.criteria['Seniority level']}`] : [],
        });
      } catch {
        failed++;
      }
      await pause(delay);
    }
    if (failed) warn(criteria, `LinkedIn: ${failed} of ${candidates.length} job pages could not be read`);
    return out;
  }
}
