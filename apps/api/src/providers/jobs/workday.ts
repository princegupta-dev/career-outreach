import { relativePosted } from '../../browser/parsers';
import { fetchJson } from '../http';
import { htmlToText } from './html-extract';
import { filterListed, JobProvider, JobProviderError, JobSearchCriteria, ProviderJob, warn } from './job-provider.interface';

/**
 * Company career sites hosted on Workday (Salesforce, Adobe, PayPal, NVIDIA...).
 * Uses the same public JSON endpoints the company's own careers page calls; no login, no scraping of HTML.
 *   list:   POST https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
 *   detail: GET  .../wday/cxs/{tenant}/{site}{externalPath}
 */
export interface WorkdayConfig {
  /** e.g. https://salesforce.wd12.myworkdayjobs.com */
  host: string;
  tenant: string;
  site: string;
}

interface ListItem {
  title?: string;
  externalPath?: string;
  locationsText?: string;
  postedOn?: string;
}
interface Detail {
  jobPostingInfo?: { title?: string; jobDescription?: string; location?: string; additionalLocations?: string[]; startDate?: string; jobReqId?: string; externalUrl?: string; remoteType?: string; timeType?: string };
}

/** Searches run per company; a few keyword searches catch backend roles without listing every job they have. */
const QUERIES = ['backend', 'software engineer', 'node.js'];
const PER_QUERY = 20;
const MAX_DETAILS = 25;

export class WorkdayProvider implements JobProvider {
  readonly kind = 'WORKDAY' as const;

  supportsUrl(url: string): boolean {
    return /myworkdayjobs\.com/.test(url);
  }

  async getJob(): Promise<ProviderJob | null> {
    return null;
  }

  async searchJobs(criteria: JobSearchCriteria, config: Record<string, unknown>): Promise<ProviderJob[]> {
    const wd = config.workday as WorkdayConfig | undefined;
    const company = String(config.companyName ?? wd?.tenant ?? '');
    if (!wd?.host || !wd.tenant || !wd.site) throw new JobProviderError('Workday source needs host, tenant and site');
    const api = `${wd.host}/wday/cxs/${wd.tenant}/${wd.site}`;
    const now = new Date();

    // 1. List: titles, locations, "Posted N Days Ago". Same path seen in two searches is one job.
    const listed = new Map<string, ListItem>();
    for (const q of QUERIES) {
      const d = await fetchJson<{ jobPostings?: ListItem[] }>(`${api}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ appliedFacets: {}, limit: PER_QUERY, offset: 0, searchText: q }),
      });
      for (const p of d.jobPostings ?? []) if (p.externalPath && p.title) listed.set(p.externalPath, p);
    }

    // 2. Cheap filter on what the list knows (title, age; location is often just "2 Locations").
    const shallow: ProviderJob[] = [...listed.values()].map((p) => ({
      provider: 'WORKDAY',
      externalId: p.externalPath!,
      url: `${wd.host}/en-US/${wd.site}${p.externalPath}`,
      title: p.title!.trim(),
      companyName: company,
      location: /^\d+ Locations$/.test(p.locationsText ?? '') ? null : (p.locationsText ?? null),
      description: '',
      postedAt: p.postedOn ? relativePosted(p.postedOn, now) : null,
    }));
    const candidates = filterListed(shallow, { ...criteria, locations: [], includeRemote: false }).slice(0, MAX_DETAILS);

    // 3. Details: full description and every location, for scoring and the India filter.
    const out: ProviderJob[] = [];
    let failed = 0;
    for (const c of candidates) {
      try {
        const d = (await fetchJson<Detail>(`${api}${c.externalId}`, { headers: { accept: 'application/json' } })).jobPostingInfo;
        if (!d) continue;
        const locations = [d.location, ...(d.additionalLocations ?? [])].filter(Boolean).join('; ');
        out.push({
          ...c,
          externalId: d.jobReqId ?? c.externalId,
          url: d.externalUrl ?? c.url,
          location: locations || c.location,
          remote: /remote/i.test(`${d.remoteType ?? ''} ${locations}`) ? true : null,
          employmentType: d.timeType ?? null,
          description: htmlToText(d.jobDescription ?? ''),
          postedAt: c.postedAt ?? (d.startDate ? new Date(d.startDate) : null),
        });
      } catch {
        failed++;
      }
    }
    if (failed) warn(criteria, `${company} (Workday): ${failed} of ${candidates.length} job details failed`);
    return out;
  }
}
