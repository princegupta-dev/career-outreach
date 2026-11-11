import * as fs from 'fs';
import * as path from 'path';
import { normalizeCompanyName } from './domain/dedupe';
import { FetchError, fetchJson } from './providers/http';
import type { DefaultSource } from './providers/jobs/default-sources';

/**
 * Small startups (default 50–100 people) and their own job boards.
 * Company list: the open YC dataset (https://yc-oss.github.io/api) — team size, locations, website, hiring flag.
 * Job board: probed on Greenhouse / Ashby / Lever public APIs and accepted only when the board names the company.
 * Nothing is scraped. Probe results are cached in a JSON file so each search does not re-probe every company.
 */
export const YC_DATASET_URL = 'https://yc-oss.github.io/api/companies/all.json';
/** Read when used (not at import), so tests can point it at a temp file. */
const cacheFile = () => process.env.STARTUP_CACHE_FILE ?? path.resolve(__dirname, '../.cache/startup-boards.json');
const REPROBE_AFTER_DAYS = 14;
const INDIA_OR_REMOTE = /india|bengaluru|bangalore|gurugram|gurgaon|delhi|noida|mumbai|pune|hyderabad|chennai|remote/i;

export interface YcCompany {
  /** YC id, or a text key for companies from other lists (e.g. "in:cred"). Used as the cache key. */
  id: number | string;
  slug?: string;
  name: string;
  website?: string;
  team_size?: number | null;
  all_locations?: string;
  regions?: string[];
  isHiring?: boolean;
  status?: string;
}

export type Ats = 'GREENHOUSE' | 'ASHBY' | 'LEVER';
export interface Board {
  ats: Ats;
  slug: string;
}
interface CacheEntry {
  board: Board | null;
  probedAt: string;
}
type Cache = Record<string, CacheEntry>;

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

export const domainOf = (site?: string | null): string | null => {
  try {
    return site ? new URL(site).hostname.replace(/^www\./, '').toLowerCase() : null;
  } catch {
    return null;
  }
};

/** Does `text` mention the company? Guards against a board slug that belongs to a different company. */
export function mentionsCompany(company: string, text: string): boolean {
  const n = squash(normalizeCompanyName(company));
  return n.length >= 3 && squash(text).includes(n);
}

/** Active, hiring, the right size, and with an office in India or remote. */
export function pickStartups(all: YcCompany[], minTeam: number, maxTeam: number): YcCompany[] {
  return all.filter(
    (c) =>
      c.status === 'Active' &&
      c.isHiring === true &&
      typeof c.team_size === 'number' &&
      c.team_size >= minTeam &&
      c.team_size <= maxTeam &&
      INDIA_OR_REMOTE.test(`${c.all_locations ?? ''} ${(c.regions ?? []).join(' ')}`),
  );
}

/** Board slugs to try, most likely first: website label, YC slug, name squashed, name hyphenated. */
export function slugCandidates(c: YcCompany): string[] {
  const label = domainOf(c.website)?.split('.')[0];
  const hyphen = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return [...new Set([label, c.slug, squash(c.name), hyphen].filter((s): s is string => !!s && /^[a-z0-9][a-z0-9-]{1,60}$/.test(s)))];
}

type Probe = (slug: string, company: string) => Promise<boolean>;

const PROBES: Record<Ats, Probe> = {
  GREENHOUSE: async (slug, company) => {
    const board = await fetchJson<{ name?: string }>(`https://boards-api.greenhouse.io/v1/boards/${slug}`);
    return !!board.name && (mentionsCompany(company, board.name) || mentionsCompany(board.name, company));
  },
  ASHBY: async (slug, company) => {
    const d = await fetchJson<{ jobs?: Array<{ title?: string; descriptionPlain?: string }> }>(`https://api.ashbyhq.com/posting-api/job-board/${slug}`, { maxBytes: 20_000_000 });
    return !!d.jobs?.slice(0, 8).some((j) => mentionsCompany(company, `${j.title ?? ''} ${j.descriptionPlain ?? ''}`));
  },
  LEVER: async (slug, company) => {
    const d = await fetchJson<Array<{ text?: string; descriptionPlain?: string }>>(`https://api.lever.co/v0/postings/${slug}?mode=json`, { maxBytes: 20_000_000 });
    return Array.isArray(d) && d.slice(0, 8).some((j) => mentionsCompany(company, `${j.text ?? ''} ${j.descriptionPlain ?? ''}`));
  },
};

/**
 * Find the company's verified board. Returns `undefined` when a network/server error got in the way,
 * so that company is retried next time instead of being cached as "no board".
 */
export async function findBoard(c: YcCompany, probes: Record<Ats, Probe> = PROBES): Promise<Board | null | undefined> {
  let failed = false;
  for (const slug of slugCandidates(c)) {
    for (const ats of Object.keys(probes) as Ats[]) {
      try {
        if (await probes[ats](slug, c.name)) return { ats, slug };
      } catch (e) {
        if (!(e instanceof FetchError && e.status === 404)) failed = true;
      }
    }
  }
  return failed ? undefined : null;
}

function readCache(): Cache {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) as Cache;
  } catch {
    return {};
  }
}

function writeCache(cache: Cache): void {
  fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
  fs.writeFileSync(cacheFile(), JSON.stringify(cache, null, 1));
}

/**
 * Find (and cache for 14 days) the verified job board of each company. Network errors are not cached,
 * so those companies are tried again next time. Shared by the startup list and the India company list.
 */
export async function resolveBoards(companies: YcCompany[], opts: { concurrency?: number; now?: Date; probe?: typeof findBoard } = {}): Promise<{ boards: Map<string, Board>; unreachable: number }> {
  const now = opts.now ?? new Date();
  const probe = opts.probe ?? findBoard;
  const cache = readCache();
  const fresh = (e?: CacheEntry) => !!e && now.getTime() - Date.parse(e.probedAt) < REPROBE_AFTER_DAYS * 86_400_000;
  const queue = companies.filter((c) => !fresh(cache[c.id]));
  let unreachable = 0;
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const board = await probe(c);
      if (board === undefined) unreachable++;
      else cache[c.id] = { board, probedAt: now.toISOString() };
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 6 }, worker));
  writeCache(cache);
  const boards = new Map<string, Board>();
  for (const c of companies) {
    const b = cache[c.id]?.board;
    if (b) boards.set(String(c.id), b);
  }
  return { boards, unreachable };
}

/** Job sources for startups of the given size, ready for `searchJobs`. */
export async function startupSources(opts: { minTeam?: number; maxTeam?: number; concurrency?: number; now?: Date } = {}): Promise<{ sources: DefaultSource[]; warnings: string[] }> {
  const all = await fetchJson<YcCompany[]>(YC_DATASET_URL, { maxBytes: 100_000_000 });
  const picked = pickStartups(all, opts.minTeam ?? 50, opts.maxTeam ?? 100);
  const { boards, unreachable } = await resolveBoards(picked, opts);
  const sources: DefaultSource[] = picked.flatMap((c) => {
    const board = boards.get(String(c.id));
    return board ? [{ provider: board.ats, name: `${c.name} (${c.team_size} people)`, config: { boardToken: board.slug, companyName: c.name, domain: domainOf(c.website) ?? undefined, teamSize: c.team_size ?? undefined } }] : [];
  });
  const warnings = unreachable ? [`${unreachable} startups could not be checked (network errors); retried next search`] : [];
  return { sources, warnings };
}
