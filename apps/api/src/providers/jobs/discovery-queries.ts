/**
 * Search terms used by sources that accept a free-text query (web search).
 * Board/feed sources list everything and are filtered by title keywords instead.
 */
export const DISCOVERY_QUERIES = [
  'Senior Backend Engineer Node.js',
  'Senior Software Engineer Node.js',
  'Senior Node.js Engineer',
  'Senior Node.js Developer',
  'Backend Engineer TypeScript',
  'Node.js TypeScript',
  'Node.js NestJS',
  'Backend Engineer Redis',
  'Backend Engineer AWS Node.js',
  'Senior Backend Engineer',
  'AI Backend Engineer',
  'Backend Engineer GenAI',
] as const;

/** Location variants appended to each query (aliases are searched separately). */
export const LOCATION_VARIANTS = [
  'Remote India',
  'Bangalore',
  'Bengaluru',
  'Gurgaon',
  'Gurugram',
  'Noida',
  'Delhi',
  'Pune',
  'Hyderabad',
  'Mumbai',
  'Remote worldwide',
] as const;

/**
 * Freshness tiers, most important first. Discovery orders work by these and the
 * scorer awards up to 5 points for freshness.
 */
export const FRESHNESS_TIERS = [
  { key: 'today', label: 'Posted today', maxHours: 24 },
  { key: '24h', label: 'Last 24 hours', maxHours: 24 },
  { key: '72h', label: 'Last 72 hours', maxHours: 72 },
  { key: '7d', label: 'Last 7 days', maxHours: 168 },
] as const;

export type FreshnessKey = (typeof FRESHNESS_TIERS)[number]['key'] | 'older' | 'unknown';

export function freshnessTier(postedAt: Date | null | undefined, now = new Date()): FreshnessKey {
  if (!postedAt) return 'unknown';
  const hours = (now.getTime() - postedAt.getTime()) / 3_600_000;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (postedAt >= startOfToday) return 'today';
  if (hours <= 24) return '24h';
  if (hours <= 72) return '72h';
  if (hours <= 168) return '7d';
  return 'older';
}

/**
 * Build the (query × location) list, capped so a run stays inside a search API's
 * daily quota. Interleaves locations so a small cap still covers several cities.
 */
export function searchPlan(maxQueries: number, queries: readonly string[] = DISCOVERY_QUERIES, locations: readonly string[] = LOCATION_VARIANTS): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < maxQueries && i < queries.length * locations.length; i++) {
    // Diagonal walk: query k pairs with location k first, so even a small cap spans many cities.
    const q = queries[i % queries.length];
    const l = locations[(i + Math.floor(i / queries.length)) % locations.length];
    out.push(`${q} ${l}`);
  }
  return out;
}
