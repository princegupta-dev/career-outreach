import type { JobProviderKind } from '@prisma/client';
import { fetchJson, FetchError } from '../http';
import { htmlToText } from './html-extract';
import { filterListed, JobProvider, JobProviderError, JobSearchCriteria, parseDate, ProviderJob, warn } from './job-provider.interface';

function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/**
 * A company board lists only the roles that are open today, so how long ago a role was first
 * published says nothing about whether it is still open. Age stays visible as a flag
 * (`age:older-than-Nd`) for ranking instead of dropping evergreen roles.
 */
const openRoles = (c: JobSearchCriteria): JobSearchCriteria => ({ ...c, postedWithinDays: undefined });

function boardToken(config: Record<string, unknown>): string {
  const t = String(config.boardToken ?? config.company ?? '').trim();
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(t)) throw new JobProviderError('A valid board token is required (e.g. "acme")');
  return t;
}

// ─── Greenhouse (public Job Board API) ───────────────────────────────────────

interface GhJob {
  id: number;
  title: string;
  absolute_url: string;
  updated_at?: string;
  first_published?: string;
  location?: { name?: string };
  content?: string;
  company_name?: string;
}

export class GreenhouseProvider implements JobProvider {
  readonly kind: JobProviderKind = 'GREENHOUSE';
  private static readonly MAX_DETAILS = 80;
  private static URL_RE = /^https?:\/\/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/([^/]+)\/jobs\/(\d+)/i;

  supportsUrl(url: string): boolean {
    return GreenhouseProvider.URL_RE.test(url);
  }

  private async companyName(token: string): Promise<string> {
    try {
      const b = await fetchJson<{ name?: string }>(`https://boards-api.greenhouse.io/v1/boards/${token}`);
      return b.name || token;
    } catch {
      return token;
    }
  }

  private map(j: GhJob, token: string, company: string): ProviderJob {
    const html = decodeEntities(j.content ?? '');
    const loc = j.location?.name ?? null;
    return {
      provider: 'GREENHOUSE',
      externalId: `${token}:${j.id}`,
      url: j.absolute_url,
      title: j.title,
      companyName: j.company_name || company,
      location: loc,
      remote: loc ? /remote/i.test(loc) : null,
      description: htmlToText(html),
      postedAt: parseDate(j.first_published) ?? parseDate(j.updated_at),
    };
  }

  /**
   * List postings WITHOUT descriptions (small response), filter by title/region,
   * then fetch full descriptions only for the survivors.
   */
  async searchJobs(criteria: JobSearchCriteria, config: Record<string, unknown>): Promise<ProviderJob[]> {
    const token = boardToken(config);
    const [data, company] = await Promise.all([
      fetchJson<{ jobs: GhJob[] }>(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs`, { maxBytes: 10_000_000 }),
      this.companyName(token),
    ]);
    // Newest first, so the cap on detail requests drops the oldest postings rather than whatever the API listed last.
    const newestFirst = (a: ProviderJob, b: ProviderJob) => (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0);
    const passed = filterListed((data.jobs ?? []).map((j) => this.map(j, token, company)), openRoles(criteria)).sort(newestFirst);
    const survivors = passed.slice(0, GreenhouseProvider.MAX_DETAILS);
    if (passed.length > survivors.length) warn(criteria, `${token}: ${passed.length - survivors.length} matching postings beyond the newest ${GreenhouseProvider.MAX_DETAILS} were not read`);
    const out: ProviderJob[] = [];
    let failed = 0;
    for (let i = 0; i < survivors.length; i += 6) {
      const batch = await Promise.all(
        survivors.slice(i, i + 6).map(async (j): Promise<ProviderJob | null> => {
          const id = j.externalId!.split(':')[1];
          try {
            const full = await fetchJson<GhJob>(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs/${id}`);
            return { ...this.map(full, token, company), location: j.location };
          } catch {
            return null;
          }
        }),
      );
      for (const x of batch) {
        if (x && x.description.length > 0) out.push(x);
        else failed++;
      }
    }
    if (failed) warn(criteria, `${token}: ${failed} of ${survivors.length} job details failed to load or were empty`);
    return out;
  }

  async getJob(url: string): Promise<ProviderJob | null> {
    const m = GreenhouseProvider.URL_RE.exec(url);
    if (!m) return null;
    const [, token, id] = m;
    try {
      const [j, company] = await Promise.all([fetchJson<GhJob>(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs/${id}`), this.companyName(token)]);
      return this.map(j, token, company);
    } catch (e) {
      if (e instanceof FetchError && e.status === 404) return null;
      throw e;
    }
  }
}

// ─── Lever (public Postings API) ─────────────────────────────────────────────

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt?: number;
  workplaceType?: string;
  categories?: { location?: string; commitment?: string; team?: string; allLocations?: string[] };
  descriptionPlain?: string;
  description?: string;
  lists?: Array<{ text: string; content: string }>;
  additionalPlain?: string;
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}

export class LeverProvider implements JobProvider {
  readonly kind: JobProviderKind = 'LEVER';
  private static URL_RE = /^https?:\/\/jobs\.(?:eu\.)?lever\.co\/([^/]+)\/([0-9a-f-]{36})/i;

  supportsUrl(url: string): boolean {
    return LeverProvider.URL_RE.test(url);
  }

  private map(p: LeverPosting, company: string): ProviderJob {
    const sections = [
      p.descriptionPlain ?? (p.description ? htmlToText(p.description) : ''),
      ...(p.lists ?? []).map((l) => `${l.text}:\n${htmlToText(l.content)}`),
      p.additionalPlain ?? '',
    ];
    const s = p.salaryRange;
    return {
      provider: 'LEVER',
      externalId: `${company}:${p.id}`,
      url: p.hostedUrl,
      title: p.text,
      companyName: company,
      location: p.categories?.allLocations?.join(' / ') || p.categories?.location || null,
      remote: p.workplaceType ? p.workplaceType === 'remote' : null,
      employmentType: p.categories?.commitment ?? null,
      description: sections.filter(Boolean).join('\n\n'),
      postedAt: parseDate(p.createdAt),
      salaryText: s?.min ? `${s.currency ?? ''} ${s.min} - ${s.max ?? s.min} ${s.interval ?? ''}`.trim() : null,
    };
  }

  async searchJobs(criteria: JobSearchCriteria, config: Record<string, unknown>): Promise<ProviderJob[]> {
    const company = boardToken(config);
    const name = String(config.companyName ?? company);
    const postings = await fetchJson<LeverPosting[]>(`https://api.lever.co/v0/postings/${company}?mode=json`, { maxBytes: 15_000_000 });
    return filterListed(postings.map((p) => ({ ...this.map(p, company), companyName: name })), openRoles(criteria));
  }

  async getJob(url: string): Promise<ProviderJob | null> {
    const m = LeverProvider.URL_RE.exec(url);
    if (!m) return null;
    try {
      return this.map(await fetchJson<LeverPosting>(`https://api.lever.co/v0/postings/${m[1]}/${m[2]}`), m[1]);
    } catch (e) {
      if (e instanceof FetchError && e.status === 404) return null;
      throw e;
    }
  }
}

// ─── Ashby (public Job Posting API) ──────────────────────────────────────────

interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  isRemote?: boolean;
  workplaceType?: string;
  employmentType?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  jobUrl?: string;
  publishedAt?: string;
  compensation?: { compensationTierSummary?: string; scrapeableCompensationSalarySummary?: string };
}

export class AshbyProvider implements JobProvider {
  readonly kind: JobProviderKind = 'ASHBY';
  private static URL_RE = /^https?:\/\/jobs\.ashbyhq\.com\/([^/]+)\/([0-9a-f-]{36})/i;

  supportsUrl(url: string): boolean {
    return AshbyProvider.URL_RE.test(url);
  }

  private map(j: AshbyJob, board: string, company: string): ProviderJob {
    const salary = j.compensation?.scrapeableCompensationSalarySummary ?? j.compensation?.compensationTierSummary ?? null;
    return {
      provider: 'ASHBY',
      externalId: `${board}:${j.id}`,
      url: j.jobUrl ?? `https://jobs.ashbyhq.com/${board}/${j.id}`,
      title: j.title,
      companyName: company,
      location: j.location ?? null,
      remote: j.isRemote ?? (j.workplaceType ? j.workplaceType === 'Remote' : null),
      employmentType: j.employmentType ?? null,
      description: j.descriptionPlain ?? (j.descriptionHtml ? htmlToText(j.descriptionHtml) : ''),
      postedAt: parseDate(j.publishedAt),
      salaryText: salary,
    };
  }

  private async board(board: string): Promise<AshbyJob[]> {
    const data = await fetchJson<{ jobs: AshbyJob[] }>(`https://api.ashbyhq.com/posting-api/job-board/${board}?includeCompensation=true`, { maxBytes: 15_000_000 });
    return data.jobs ?? [];
  }

  async searchJobs(criteria: JobSearchCriteria, config: Record<string, unknown>): Promise<ProviderJob[]> {
    const board = boardToken(config);
    const name = String(config.companyName ?? board);
    return filterListed((await this.board(board)).map((j) => this.map(j, board, name)), openRoles(criteria));
  }

  async getJob(url: string): Promise<ProviderJob | null> {
    const m = AshbyProvider.URL_RE.exec(url);
    if (!m) return null;
    const job = (await this.board(m[1])).find((j) => j.id === m[2]);
    return job ? this.map(job, m[1], m[1]) : null;
  }
}
