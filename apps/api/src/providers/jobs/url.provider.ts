import type { JobProviderKind } from '@prisma/client';
import { httpFetch, isAllowedByRobots } from '../http';
import { extractPostingFromHtml } from './html-extract';
import { JobProvider, JobProviderError, ProviderJob } from './job-provider.interface';

/**
 * Sites whose terms prohibit automated access, or that use anti-bot protection.
 * We never try to bypass these — the user pastes the JD instead.
 */
const BLOCKED_HOSTS = [/(^|\.)linkedin\.com$/i, /(^|\.)indeed\./i, /(^|\.)glassdoor\./i, /(^|\.)naukri\.com$/i, /(^|\.)wellfound\.com$/i, /(^|\.)angel\.co$/i, /(^|\.)instahyre\.com$/i, /(^|\.)monster\./i];

export class UrlJobProvider implements JobProvider {
  readonly kind: JobProviderKind = 'URL';

  supportsUrl(url: string): boolean {
    return /^https?:\/\//i.test(url);
  }

  async searchJobs(): Promise<ProviderJob[]> {
    return []; // A single URL cannot be searched.
  }

  async getJob(url: string): Promise<ProviderJob | null> {
    const u = new URL(url);
    if (BLOCKED_HOSTS.some((re) => re.test(u.hostname))) {
      throw new JobProviderError(`${u.hostname} does not allow automated fetching. Paste the job description instead.`);
    }
    if (!(await isAllowedByRobots(url))) {
      throw new JobProviderError(`${u.hostname}'s robots.txt disallows fetching this page. Paste the job description instead.`);
    }
    const res = await httpFetch(url);
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      throw new JobProviderError(`${u.hostname} refused the request (HTTP ${res.status}). Paste the job description instead.`);
    }
    if (res.status >= 400) throw new JobProviderError(`HTTP ${res.status} from ${u.hostname}`);
    if (!/html/i.test(res.contentType)) throw new JobProviderError('The URL did not return an HTML page.');
    const posting = extractPostingFromHtml(res.text);
    if (!posting) throw new JobProviderError('Could not find a job description on that page. Paste it instead.');
    return {
      provider: 'URL',
      externalId: null,
      url,
      title: posting.title ?? 'Untitled role',
      companyName: posting.companyName ?? u.hostname.replace(/^www\./, '').split('.')[0],
      companyWebsite: posting.companyWebsite ?? null,
      location: posting.location ?? null,
      remote: posting.remote ?? null,
      employmentType: posting.employmentType ?? null,
      description: posting.description,
      postedAt: posting.postedAt ?? null,
      salaryText: posting.salaryText ?? null,
    };
  }
}
