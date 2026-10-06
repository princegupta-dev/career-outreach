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
