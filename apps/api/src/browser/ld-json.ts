import { htmlToText } from '../providers/jobs/html-extract';
import { parseDate, ProviderJob } from '../providers/jobs/job-provider.interface';
import type { JobProviderKind } from '../types';

/**
 * Job sites embed schema.org `JobPosting` data (as <script type="application/ld+json">) so Google can show
 * their jobs. It is a public, documented format, so reading it is far more stable than guessing page layouts.
 * https://developers.google.com/search/docs/appearance/structured-data/job-posting
 */
type Ld = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const isType = (o: Ld, t: string) => [o['@type']].flat().includes(t);

/** Flatten the shapes sites use: a single object, an array, or { "@graph": [...] }. */
function flatten(v: unknown): Ld[] {
  if (Array.isArray(v)) return v.flatMap(flatten);
  if (!v || typeof v !== 'object') return [];
  const o = v as Ld;
  return Array.isArray(o['@graph']) ? flatten(o['@graph']) : [o];
}

function locationOf(p: Ld): string | null {
  const places = [p.jobLocation].flat().filter(Boolean) as Ld[];
  const parts = places.map((pl) => {
    const a = (pl.address ?? {}) as Ld;
    if (typeof pl.address === 'string') return pl.address;
    return [str(a.addressLocality), str(a.addressRegion), str((a.addressCountry as Ld)?.name) ?? str(a.addressCountry)].filter(Boolean).join(', ');
  });
  const remote = p.jobLocationType === 'TELECOMMUTE';
  const where = [...new Set(parts.filter(Boolean))].join('; ');
  return [where, remote ? 'Remote' : ''].filter(Boolean).join(' · ') || null;
}

function salaryOf(p: Ld): string | null {
  const s = p.baseSalary as Ld | undefined;
  if (!s || typeof s !== 'object') return null;
  const v = (s.value ?? {}) as Ld;
  const min = v.minValue ?? v.value;
  const max = v.maxValue;
  if (min == null && max == null) return null;
  return `${str(s.currency) ?? ''} ${min ?? ''}${max != null ? `–${max}` : ''} ${str(v.unitText)?.toLowerCase() ?? ''}`.replace(/\s+/g, ' ').trim();
}

/** Turn the text of every ld+json script on a page into postings. Bad JSON is skipped, never fatal. */
export function parseJobPostings(scripts: string[], provider: JobProviderKind, pageUrl: string, now = new Date()): ProviderJob[] {
  const out: ProviderJob[] = [];
  for (const raw of scripts) {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const p of flatten(data).filter((o) => isType(o, 'JobPosting'))) {
      const title = str(p.title);
      const org = (p.hiringOrganization ?? {}) as Ld;
      const company = str(org.name) ?? (typeof p.hiringOrganization === 'string' ? p.hiringOrganization : null);
      if (!title || !company) continue;
      // An expired posting is not "latest", however recently it was published.
      const until = parseDate(p.validThrough);
      if (until && until < now) continue;
      const url = str(p.url) ?? pageUrl;
      const identifier = p.identifier as Ld | string | undefined;
      out.push({
        provider,
        externalId: (typeof identifier === 'object' ? str(identifier?.value) ?? str(identifier?.name) : str(identifier)) ?? url,
        url,
        title,
        companyName: company,
        companyWebsite: str(org.sameAs) ?? str(org.url),
        location: locationOf(p),
        remote: p.jobLocationType === 'TELECOMMUTE' ? true : null,
        employmentType: [p.employmentType].flat().filter((x) => typeof x === 'string').join(', ') || null,
        description: htmlToText(str(p.description) ?? ''),
        postedAt: parseDate(p.datePosted),
        salaryText: salaryOf(p),
      });
    }
  }
  return out;
}
