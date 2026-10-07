import { sha256 } from '../common/crypto';

/** Normalise a company name for matching ("Acme, Inc." → "acme"). */
export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\b(inc|incorporated|llc|ltd|limited|pvt|private|corp|corporation|co|gmbh|plc|technologies|technology|labs|hq)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function normalizeForHash(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Content hash: same company + title + description ⇒ same job, even when posted on
 * different boards or under different URLs.
 */
export function jobContentHash(input: { companyName: string; title: string; description: string }): string {
  return sha256([normalizeCompanyName(input.companyName), normalizeForHash(input.title), normalizeForHash(input.description)].join('|'));
}

/** Canonical URL: lowercase host, drop tracking params / fragments / trailing slash. */
export function canonicalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    const drop = [/^utm_/i, /^ref$/i, /^source$/i, /^gh_src$/i, /^lever-source/i, /^trk/i, /^fbclid$/i, /^gclid$/i];
    for (const key of [...u.searchParams.keys()]) if (drop.some((re) => re.test(key))) u.searchParams.delete(key);
    u.searchParams.sort();
    let s = u.toString();
    if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch {
    return null;
  }
}

/** Source hash: provider-level identity (provider + external id, or canonical URL). */
export function jobSourceHash(input: { provider: string; externalId?: string | null; url?: string | null }): string | null {
  if (input.externalId) return sha256(`${input.provider}:${input.externalId}`);
  const url = input.url ? canonicalizeUrl(input.url) : null;
  return url ? sha256(`url:${url}`) : null;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function emailDomain(email: string): string {
  return normalizeEmail(email).split('@')[1] ?? '';
}

/** "Sr. Backend Engineer (Node.js)" → "senior backend engineer node js". Seniority is kept: senior ≠ mid-level. */
export function normalizeRole(title: string): string {
  return title
    .toLowerCase()
    .replace(/\bsr\.?(?=\s)/g, 'senior')
    .replace(/\bjr\.?(?=\s)/g, 'junior')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(m f d|f m x|m w d|h f)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CITY_ALIASES: Array<[RegExp, string]> = [
  [/\bbengaluru\b/g, 'bangalore'],
  [/\bgurugram\b/g, 'gurgaon'],
  [/\bnew delhi\b/g, 'delhi'],
  [/\bbombay\b/g, 'mumbai'],
  [/\bwork from home\b|\bwfh\b/g, 'remote'],
];

/** "Bengaluru, Karnataka, India" and "Bangalore, India" → the same key. */
export function normalizeLocation(location: string | null | undefined): string {
  let s = (location ?? '').toLowerCase();
  for (const [re, to] of CITY_ALIASES) s = s.replace(re, to);
  const tokens = s
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t && !['india', 'in', 'karnataka', 'haryana', 'maharashtra', 'telangana', 'up', 'uttar', 'pradesh', 'ncr', 'hybrid', 'onsite', 'on', 'site', 'office'].includes(t));
  return [...new Set(tokens)].sort().join(' ');
}

/**
 * Deterministic duplicate key for postings without an external id:
 * normalized company + normalized role + normalized location.
 */
export function jobDedupeKey(input: { companyName: string; title: string; location?: string | null }): string {
  return sha256([normalizeCompanyName(input.companyName), normalizeRole(input.title), normalizeLocation(input.location)].join('|'));
}
