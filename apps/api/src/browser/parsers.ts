import * as cheerio from 'cheerio';
import { htmlToText } from '../providers/jobs/html-extract';
import type { ProviderJob } from '../providers/jobs/job-provider.interface';

/**
 * Site-specific readers for search pages whose jobs are not published as schema.org JobPosting.
 * Each reads the HTML the user's own browser already received; no extra requests.
 */

type Rec = Record<string, unknown>;

/** Next.js pages carry their data in <script id="__NEXT_DATA__">. */
export function nextData(html: string): Rec | null {
  const raw = cheerio.load(html)('script#__NEXT_DATA__').text();
  try {
    return raw ? (JSON.parse(raw) as Rec) : null;
  } catch {
    return null;
  }
}

/** Wellfound reports company size as a band, e.g. SIZE_11_50. We keep the upper bound. */
export function wellfoundTeamSize(band: unknown): number | null {
  const m = typeof band === 'string' ? band.match(/SIZE_(\d+)_(\d+)/) : null;
  if (m) return Number(m[2]);
  return typeof band === 'string' && /SIZE_(\d+)_PLUS|SIZE_10000/.test(band) ? 10_000 : null;
}

/**
 * Wellfound search page: the Apollo cache in __NEXT_DATA__ holds StartupResult entries, each pointing at its
 * JobListingSearchResult entries (title, full description, live-since time, locations, remote, experience).
 */
export function parseWellfoundSearch(html: string): ProviderJob[] {
  const data = ((((nextData(html)?.props as Rec)?.pageProps as Rec)?.apolloState as Rec)?.data ?? {}) as Record<string, Rec>;
  const out: ProviderJob[] = [];
  for (const [key, startup] of Object.entries(data)) {
    if (!key.startsWith('StartupResult:')) continue;
    const refs = (startup.highlightedJobListings ?? []) as Array<{ __ref?: string }>;
    for (const ref of refs) {
      const j = ref.__ref ? data[ref.__ref] : undefined;
      if (!j || typeof j.title !== 'string') continue;
      const locations = (j.locationNames ?? []) as string[];
      const remoteOk = (j.acceptedRemoteLocationNames ?? []) as string[];
      const remote = j.remote === true || (j.remoteConfig as Rec | undefined)?.kind === 'REMOTE';
      const location = [...locations, ...(remote ? [`Remote${remoteOk.length ? ` (${remoteOk.join(', ')})` : ''}`] : [])].join('; ') || null;
      const years = typeof j.yearsExperienceMin === 'number' ? `\n\nExperience: ${j.yearsExperienceMin}${typeof j.yearsExperienceMax === 'number' ? `–${j.yearsExperienceMax}` : '+'} years` : '';
      const live = Number(j.liveStartAt);
      out.push({
        provider: 'WELLFOUND',
        externalId: String(j.id),
        url: `https://wellfound.com/jobs/${j.id}-${String(j.slug ?? '')}`,
        title: j.title.trim(),
        companyName: String(startup.name ?? ''),
        location,
        remote,
        employmentType: typeof j.jobType === 'string' ? j.jobType : null,
        description: htmlToText(String(j.description ?? '')) + years,
        postedAt: Number.isFinite(live) && live > 0 ? new Date(live * 1000) : null,
        salaryText: typeof j.compensation === 'string' && j.compensation ? j.compensation : null,
        companyMeta: { teamSize: wellfoundTeamSize(startup.companySize), careerUrl: `https://wellfound.com/company/${String(startup.slug ?? '')}` },
      });
    }
  }
  return out;
}

/** "Posted 3 days ago", "Posted 1 week ago", "Posted today" → a date. Unknown text → null. */
export function relativePosted(text: string, now: Date): Date | null {
  const t = text.toLowerCase();
  if (/today|just now|hour|minute/.test(t)) return now;
  if (/yesterday/.test(t)) return new Date(now.getTime() - 86_400_000);
  const m = t.match(/(\d+)\+?\s*(day|week|month)/);
  if (!m) return null;
  const days = Number(m[1]) * (m[2] === 'week' ? 7 : m[2] === 'month' ? 30 : 1);
  return new Date(now.getTime() - days * 86_400_000);
}

/**
 * Hirist search page: each job card has stable data-testid labels. The card has no full description, so the
 * description is built from the card's own facts (skills, experience, location) and flagged as card-only.
 */
export function parseHiristSearch(html: string, now = new Date()): ProviderJob[] {
  const $ = cheerio.load(html);
  const out: ProviderJob[] = [];
  $('.joblist-card-v2').each((_, el) => {
    const card = $(el);
    const href = card.find('a[href^="/j/"]').attr('href');
    const heading = card.find('[data-testid="job_title"]').first().text().trim();
    if (!href || !heading) return;
    // Titles read "Company - Role - Detail": the company is the first part.
    const [company, ...rest] = heading.split(' - ');
    const title = rest.length ? rest.join(' - ') : heading;
    const experience = card.find('[data-testid="job_experience"]').first().text().trim();
    const location = card.find('[data-testid="job_location"]').first().text().trim();
    const skills = card.find('[data-testid^="job_tag_"]').map((_i, t) => $(t).text().trim()).get().filter(Boolean);
    const posted = card.find('[data-testid="date_posted"]').first().text().trim();
    const path = href.split('?')[0];
    out.push({
      provider: 'HIRIST',
      externalId: path.match(/-(\d+)$/)?.[1] ?? path,
      url: `https://www.hirist.tech${path}`,
      title: title.trim(),
      companyName: rest.length ? company.trim() : 'Unknown (Hirist)',
      location: location || null,
      remote: /remote/i.test(location) ? true : null,
      description: [`${heading}.`, skills.length ? `Skills: ${skills.join(', ')}.` : '', experience ? `Experience: ${experience}.` : '', location ? `Location: ${location}.` : ''].filter(Boolean).join('\n'),
      postedAt: posted ? relativePosted(posted, now) : null,
      flags: ['source:card-only'],
    });
  });
  return out;
}

/**
 * Hirist fallback: every search page carries a schema.org ItemList (name "Company - Role", url) even when the
 * job cards have not rendered. Less detail (no location or date), so it is used only when no cards were found.
 */
export function parseHiristItemList(html: string): ProviderJob[] {
  const $ = cheerio.load(html);
  const out: ProviderJob[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    let data: Rec;
    try {
      data = JSON.parse($(el).text()) as Rec;
    } catch {
      return;
    }
    if (data['@type'] !== 'ItemList') return;
    for (const item of (data.itemListElement ?? []) as Rec[]) {
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      const url = typeof item.url === 'string' ? item.url.split('?')[0] : '';
      if (!name || !/hirist\.tech\/j\//.test(url)) continue;
      const [company, ...rest] = name.split(' - ');
      out.push({
        provider: 'HIRIST',
        externalId: url.match(/-(\d+)$/)?.[1] ?? url,
        url,
        title: (rest.length ? rest.join(' - ') : name).trim(),
        companyName: rest.length ? company.trim() : 'Unknown (Hirist)',
        location: null,
        remote: null,
        description: `${name}. Listed on Hirist (India tech jobs). Details are on the job page.`,
        postedAt: null,
        flags: ['source:list-only'],
      });
    }
  });
  return out;
}

/**
 * Naukri search results, from the JSON its own page loads (`/jobapi/v3/search`), which the browser already received.
 * Flags tell the auto-apply tool what it is facing: `apply:company-site` (Apply opens the employer's site) and
 * `apply:questions` (Apply asks extra questions).
 */
export function parseNaukriSearch(body: string): ProviderJob[] {
  let data: Rec;
  try {
    data = JSON.parse(body) as Rec;
  } catch {
    return [];
  }
  const out: ProviderJob[] = [];
  for (const j of (data.jobDetails ?? []) as Rec[]) {
    const title = typeof j.title === 'string' ? j.title.trim() : '';
    const company = typeof j.companyName === 'string' ? j.companyName.trim() : '';
    const path = typeof j.jdURL === 'string' ? j.jdURL : '';
    if (!title || !company || !path) continue;
    const label = (type: string) => ((j.placeholders ?? []) as Rec[]).find((p) => p.type === type)?.label as string | undefined;
    const location = label('location') ?? null;
    const salary = label('salary');
    const experience = label('experience') ?? (typeof j.experienceText === 'string' ? j.experienceText : '');
    const skills = typeof j.tagsAndSkills === 'string' ? j.tagsAndSkills.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const created = Number(j.createdDate);
    out.push({
      provider: 'NAUKRI',
      externalId: String(j.jobId ?? path),
      url: path.startsWith('http') ? path : `https://www.naukri.com${path}`,
      title,
      companyName: company,
      location,
      remote: /remote|work from home/i.test(location ?? '') ? true : null,
      description: [htmlToText(String(j.jobDescription ?? '')), skills.length ? `Skills: ${skills.join(', ')}.` : '', experience ? `Experience: ${experience}.` : ''].filter(Boolean).join('\n'),
      postedAt: Number.isFinite(created) && created > 0 ? new Date(created) : null,
      salaryText: salary && !/not disclosed/i.test(salary) ? salary : null,
      flags: [...(j.companyApplyJob === true ? ['apply:company-site'] : []), ...(j.questionnaireIdPresent === true ? ['apply:questions'] : [])],
    });
  }
  return out;
}

/**
 * Instahyre search results, from the JSON its own page loads (`/api/v1/job_search`). The list has no description and
 * no posting date: the description is built from the job's own skill keywords and company note, and the date is left
 * unknown (flagged), never invented.
 */
export function parseInstahyreSearch(body: string): ProviderJob[] {
  let data: Rec;
  try {
    data = JSON.parse(body) as Rec;
  } catch {
    return [];
  }
  const out: ProviderJob[] = [];
  for (const o of (data.objects ?? []) as Rec[]) {
    const employer = (o.employer ?? {}) as Rec;
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    const company = typeof employer.company_name === 'string' ? employer.company_name.trim() : '';
    const url = typeof o.public_url === 'string' ? o.public_url : '';
    if (!title || !company || !url || o.is_active === false) continue;
    const keywords = Array.isArray(o.keywords) ? (o.keywords as unknown[]).filter((k): k is string => typeof k === 'string') : [];
    const location = typeof o.locations === 'string' ? o.locations : null;
    const note = typeof employer.instahyre_note === 'string' ? employer.instahyre_note : '';
    const size = Number(employer.employee_count);
    out.push({
      provider: 'INSTAHYRE',
      externalId: String(o.id ?? url),
      url,
      title,
      companyName: company,
      location,
      remote: /remote/i.test(location ?? '') ? true : null,
      description: [`${title} at ${company}.`, keywords.length ? `Skills: ${keywords.join(', ')}.` : '', note].filter(Boolean).join('\n'),
      postedAt: null,
      companyMeta: Number.isFinite(size) && size > 0 ? { teamSize: size } : undefined,
      flags: ['source:list-only'],
    });
  }
  return out;
}
