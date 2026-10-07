import type { JobProviderKind } from '@prisma/client';
import type { ContactCandidate } from '../contacts/contact-provider';

/** Normalised job as returned by any provider (before persistence). */
export interface ProviderJob {
  provider: JobProviderKind;
  externalId?: string | null;
  url?: string | null;
  title: string;
  companyName: string;
  companyDomain?: string | null;
  companyWebsite?: string | null;
  location?: string | null;
  remote?: boolean | null;
  employmentType?: string | null;
  description: string;
  postedAt?: Date | null;
  salaryText?: string | null;
  /** Contacts published in the posting itself (e.g. HN "email me at …"). */
  contacts?: ContactCandidate[];
  /** Where to apply, when different from `url` (e.g. YC listing → company ATS). */
  applicationUrl?: string | null;
  /** Page the posting was discovered on, when different from `url` (e.g. a search result). */
  sourceUrl?: string | null;
  /** Experience requirement as published ("4-6 years", "3+ years"). */
  experienceText?: string | null;
}

export interface JobSearchCriteria {
  /** Title must contain one of these (case-insensitive). Empty = no filter. */
  titleKeywords: string[];
  /** Title must not contain any of these. */
  excludeTitleKeywords: string[];
  /** Location must contain one of these, or the job must be remote. Empty = no filter. */
  locations: string[];
  includeRemote: boolean;
  postedWithinDays?: number;
  limit?: number;
  allowRelocation?: boolean;
  /** Providers add the number of postings they listed (before filtering) for the funnel. */
  stats?: { fetched: number };
}

export interface JobProvider {
  readonly kind: JobProviderKind;
  /** Can this provider resolve the given URL? */
  supportsUrl(url: string): boolean;
  /** Returns postings that pass the basic filters (providers may use them to avoid fetching details). */
  searchJobs(criteria: JobSearchCriteria, config: Record<string, unknown>): Promise<ProviderJob[]>;
  getJob(url: string): Promise<ProviderJob | null>;
}

export class JobProviderError extends Error {}

const INDIA = /\b(india|bangalore|bengaluru|gurgaon|gurugram|noida|delhi|ncr|pune|hyderabad|mumbai|chennai|kolkata|ahmedabad|jaipur|indore|chandigarh|kochi|trivandrum|coimbatore)\b/i;
const GLOBAL = /\b(worldwide|anywhere|global|globally|international|apac|asia|asia[- ]pacific|all locations|any location|any timezone|any time zone)\b/i;
const FOREIGN =
  /\b(us|usa|u\.s\.?|united states|america|americas|canada|north america|latam|latin america|south america|europe|european|eu|emea|uk|united kingdom|england|london|germany|berlin|france|paris|spain|netherlands|amsterdam|poland|portugal|ireland|dublin|switzerland|sweden|denmark|norway|finland|australia|sydney|new zealand|brazil|mexico|argentina|colombia|japan|tokyo|israel|uae|dubai|san francisco|new york|nyc|seattle|austin|boston|toronto|vancouver|cet|est|pst|cst|utc[+-]?[0-9]*)\b/i;

const kwCache = new Map<string, RegExp>();
/** Keyword match on token boundaries ("rust" must not match "trust", ".net"/"c++" work). */
export function titleHas(title: string, keyword: string): boolean {
  const k = keyword.trim().toLowerCase();
  if (!k) return false;
  let re = kwCache.get(k);
  if (!re) {
    re = new RegExp(`(^|[^a-z0-9+#.])${k.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}($|[^a-z0-9+#])`, 'i');
    kwCache.set(k, re);
  }
  return re.test(title);
}

/** For a remote job: is the allowed region compatible with someone based in India? */
export function remoteRegionOk(location: string | null | undefined): boolean {
  const loc = (location ?? '').trim();
  if (!loc || /^remote\.?$/i.test(loc)) return true;
  if (INDIA.test(loc) || GLOBAL.test(loc)) return true;
  return !FOREIGN.test(loc);
}

export function isIndiaLocation(location: string | null | undefined): boolean {
  return INDIA.test(location ?? '');
}

/**
 * Cheap pre-filter applied before any scoring (step 1 of the token-saving pipeline):
 * title keywords, region compatibility, posting age.
 */
export function passesBasicFilters(
  job: Pick<ProviderJob, 'title' | 'location' | 'remote' | 'postedAt'>,
  c: JobSearchCriteria,
  now = new Date(),
): boolean {
  const title = job.title.toLowerCase();
  if (c.titleKeywords.length && !c.titleKeywords.some((k) => titleHas(title, k))) return false;
  if (c.excludeTitleKeywords.some((k) => titleHas(title, k))) return false;
  if (c.locations.length || c.includeRemote) {
    const loc = (job.location ?? '').toLowerCase();
    const remote = job.remote === true || /\bremote\b|anywhere|worldwide|work from home|distributed/.test(loc);
    const locOk = c.locations.some((l) => loc.includes(l.toLowerCase())) || INDIA.test(loc);
    if (!locOk) {
      if (remote) {
        if (!c.includeRemote || !remoteRegionOk(job.location)) return false;
      } else if (loc && !c.allowRelocation) {
        return false;
      }
    }
  }
  if (c.postedWithinDays && job.postedAt && now.getTime() - job.postedAt.getTime() > c.postedWithinDays * 86_400_000) return false;
  return true;
}

/** Count listed postings and keep only those passing the basic filters. */
export function filterListed(all: ProviderJob[], c: JobSearchCriteria): ProviderJob[] {
  if (c.stats) c.stats.fetched += all.length;
  return all.filter((j) => passesBasicFilters(j, c)).slice(0, c.limit ?? 500);
}
