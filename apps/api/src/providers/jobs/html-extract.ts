import * as cheerio from 'cheerio';

export interface ExtractedPosting {
  title?: string;
  companyName?: string;
  companyWebsite?: string;
  location?: string;
  remote?: boolean;
  description: string;
  postedAt?: Date;
  employmentType?: string;
  salaryText?: string;
}

/** Convert HTML to readable plain text, keeping list items and paragraphs on separate lines. */
export function htmlToText(html: string): string {
  // Some sources (e.g. HN) use unclosed <p> tags: make sure paragraphs never run together.
  const $ = cheerio.load(html.replace(/<p(\s[^>]*)?>/gi, '\n$&'));
  $('script, style, noscript, svg, iframe, nav, footer, header, form').remove();
  $('br').replaceWith('\n');
  $('li').each((_, el) => {
    $(el).prepend('- ');
    $(el).append('\n');
  });
  $('p, div, h1, h2, h3, h4, h5, h6, ul, ol, section, article, tr').each((_, el) => {
    $(el).append('\n');
  });
  return $.root()
    .text()
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}

function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

interface JsonLdPosting {
  '@type'?: string | string[];
  title?: string;
  description?: string;
  datePosted?: string;
  employmentType?: string | string[];
  jobLocationType?: string;
  hiringOrganization?: { name?: string; sameAs?: string; url?: string } | string;
  jobLocation?: Array<{ address?: { addressLocality?: string; addressRegion?: string; addressCountry?: string | { name?: string } } }> | { address?: { addressLocality?: string; addressRegion?: string; addressCountry?: string | { name?: string } } };
  baseSalary?: { currency?: string; value?: { minValue?: number; maxValue?: number; value?: number; unitText?: string } };
  '@graph'?: JsonLdPosting[];
}

function findPosting(node: unknown): JsonLdPosting | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const p = findPosting(n);
      if (p) return p;
    }
    return null;
  }
  const obj = node as JsonLdPosting;
  if (asArray(obj['@type']).includes('JobPosting')) return obj;
  if (obj['@graph']) return findPosting(obj['@graph']);
  return null;
}

/** Extract a job posting from HTML: schema.org JobPosting JSON-LD first, then page text. */
export function extractPostingFromHtml(html: string): ExtractedPosting | null {
  const $ = cheerio.load(html);
  let posting: JsonLdPosting | null = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (posting) return;
    try {
      posting = findPosting(JSON.parse($(el).contents().text()));
    } catch {
      /* ignore malformed JSON-LD */
    }
  });

  if (posting) {
    const p = posting as JsonLdPosting;
    const org = typeof p.hiringOrganization === 'string' ? { name: p.hiringOrganization } : p.hiringOrganization;
    const loc = asArray(p.jobLocation)
      .map((l) => {
        const a = l.address ?? {};
        const country = typeof a.addressCountry === 'object' ? a.addressCountry?.name : a.addressCountry;
        return [a.addressLocality, a.addressRegion, country].filter(Boolean).join(', ');
      })
      .filter(Boolean)
      .join(' / ');
    const sal = p.baseSalary?.value;
    const salaryText =
      sal && (sal.minValue || sal.value)
        ? `${p.baseSalary?.currency ?? ''} ${sal.minValue ?? sal.value}${sal.maxValue ? ` - ${sal.maxValue}` : ''} ${sal.unitText ? `per ${sal.unitText.toLowerCase()}` : ''}`.trim()
        : undefined;
    const description = htmlToText(p.description ?? '');
    if (description.length > 100) {
      return {
        title: p.title,
        companyName: org?.name,
        companyWebsite: org?.sameAs ?? org?.url,
        location: loc || undefined,
        remote: p.jobLocationType === 'TELECOMMUTE' ? true : undefined,
        description,
        postedAt: p.datePosted && !isNaN(Date.parse(p.datePosted)) ? new Date(p.datePosted) : undefined,
        employmentType: asArray(p.employmentType).join(', ') || undefined,
        salaryText,
      };
    }
  }

  // Fallback: main content text.
  const title = $('meta[property="og:title"]').attr('content') ?? $('h1').first().text().trim() ?? $('title').text().trim();
  const siteName = $('meta[property="og:site_name"]').attr('content');
  const main = $('main').html() ?? $('article').html() ?? $('[role="main"]').html() ?? $('body').html() ?? '';
  const description = htmlToText(main);
  if (description.length < 200) return null;
  return { title: title || undefined, companyName: siteName, description: description.slice(0, 30000) };
}

/** Best-effort company facts from a homepage: only what the company says about itself. */
export function extractCompanyMeta(html: string): { title?: string; description?: string } {
  const $ = cheerio.load(html);
  const description = $('meta[name="description"]').attr('content') ?? $('meta[property="og:description"]').attr('content');
  const title = $('meta[property="og:site_name"]').attr('content') ?? $('title').text().trim();
  return { title: title || undefined, description: description?.trim() || undefined };
}
