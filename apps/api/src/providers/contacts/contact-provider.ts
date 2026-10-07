import type { ContactConfidence, ContactRole, ContactSourceType, EmailVerificationStatus } from '@prisma/client';
import { categorizeRole } from '../../domain/contacts/rank';
import { fetchJson } from '../http';

export interface ContactCandidate {
  name: string;
  role?: string | null;
  roleCategory: ContactRole;
  email?: string | null;
  linkedinUrl?: string | null;
  source: string;
  sourceUrl?: string | null;
  confidence: ContactConfidence;
  /** Kind of public source the address was found on. */
  sourceType: ContactSourceType;
  /** PUBLICLY_LISTED when the company published it; VERIFIED only with an independent check. */
  verificationStatus: EmailVerificationStatus;
}

/** Status of the contact-discovery attempt for a job. */
export type ContactDiscoveryStatus = 'FOUND' | 'EMAIL_NOT_FOUND';

export interface ContactSearchInput {
  companyName: string;
  domain?: string | null;
  jobDescription?: string;
  jobUrl?: string | null;
}

export interface ContactProvider {
  readonly name: string;
  readonly enabled: boolean;
  findContacts(input: ContactSearchInput): Promise<ContactCandidate[]>;
}

const GENERIC_LOCAL = /^(careers?|jobs?|hiring|recruit(ing|ment|er)?|talent|hr|people|apply|join|work|team|hello|info|contact)$/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Contacts that are published in the job posting itself (e.g. "send your CV to
 * jane@acme.com"). These are public, purpose-given addresses.
 */
export class JobPostingContactProvider implements ContactProvider {
  readonly name = 'job_posting';
  readonly enabled = true;

  async findContacts(input: ContactSearchInput): Promise<ContactCandidate[]> {
    const text = input.jobDescription ?? '';
    const out: ContactCandidate[] = [];
    const seen = new Set<string>();
    for (const m of text.matchAll(EMAIL_RE)) {
      const email = m[0].replace(/\.$/, '').toLowerCase();
      if (seen.has(email) || /\.(png|jpe?g|gif|svg)$/.test(email) || /@example\.(com|org|net)$|sentry|noreply|no-reply/.test(email)) continue;
      seen.add(email);
      const local = email.split('@')[0];
      // Look for "Name (Title)" or "Name, Title" right before the address — never guess a name.
      const before = text.slice(Math.max(0, (m.index ?? 0) - 120), m.index).split('\n').pop() ?? '';
      const named = /([A-Z][a-z]+(?:\s[A-Z][a-z]+){1,2})(?:,?\s*\(?([A-Za-z ,&-]{3,60})\)?)?\s*(?:at|:|-|–|<|\()?\s*$/.exec(before);
      const generic = GENERIC_LOCAL.test(local.replace(/[._-].*$/, ''));
      out.push({
        name: named && !generic ? named[1] : `${input.companyName} hiring team`,
        role: named?.[2]?.trim() || (generic ? 'Shared hiring inbox' : null),
        roleCategory: generic ? 'RECRUITER' : categorizeRole(named?.[2]),
        email,
        source: this.name,
        sourceUrl: input.jobUrl ?? null,
        confidence: 'VERIFIED',
        sourceType: 'JOB_POSTING',
        verificationStatus: 'PUBLICLY_LISTED',
      });
    }
    return out;
  }
}

interface HunterEmail {
  value: string;
  type?: string;
  confidence?: number;
  first_name?: string | null;
  last_name?: string | null;
  position?: string | null;
  department?: string | null;
  linkedin?: string | null;
  verification?: { status?: string | null };
  sources?: Array<{ uri?: string }>;
}

/**
 * Hunter.io Domain Search — a permitted data provider of public professional
 * emails. Optional; requires HUNTER_API_KEY. Results carry Hunter's own
 * verification status, which we map honestly to our confidence levels.
 */
export class HunterContactProvider implements ContactProvider {
  readonly name = 'hunter';
  constructor(private readonly apiKey?: string) {}

  get enabled(): boolean {
    return !!this.apiKey;
  }

  async findContacts(input: ContactSearchInput): Promise<ContactCandidate[]> {
    if (!this.apiKey || !input.domain) return [];
    const params = new URLSearchParams({ domain: input.domain, limit: '25', department: 'it,executive,hr,management' });
    const res = await fetchJson<{ data?: { emails?: HunterEmail[] } }>(`https://api.hunter.io/v2/domain-search?${params}`, {
      headers: { 'X-API-KEY': this.apiKey },
    });
    // Only addresses Hunter found published on public web pages are kept. Pattern-derived
    // guesses (no `sources`) are dropped — we never email an address nobody published.
    return (res.data?.emails ?? [])
      .filter((e) => e.value && (e.first_name || e.type === 'generic') && (e.sources ?? []).some((s) => !!s.uri))
      .map((e) => {
        const status = e.verification?.status;
        const confidence: ContactConfidence = status === 'valid' ? 'VERIFIED' : (e.confidence ?? 0) >= 80 ? 'LIKELY' : 'UNVERIFIED';
        const verificationStatus: EmailVerificationStatus = status === 'invalid' ? 'INVALID' : status === 'valid' ? 'VERIFIED' : 'PUBLICLY_LISTED';
        const name = [e.first_name, e.last_name].filter(Boolean).join(' ') || `${input.companyName} team`;
        return {
          name,
          role: e.position ?? e.department ?? null,
          roleCategory: categorizeRole(e.position ?? e.department),
          email: e.value.toLowerCase(),
          linkedinUrl: e.linkedin ? (e.linkedin.startsWith('http') ? e.linkedin : `https://www.linkedin.com/in/${e.linkedin}`) : null,
          source: this.name,
          sourceUrl: e.sources?.find((s) => !!s.uri)?.uri ?? null,
          confidence,
          sourceType: 'DATA_PROVIDER' as const,
          verificationStatus,
        };
      });
  }
}

const HIRING_INBOX = /^(careers?|jobs?|hiring|talent|recruit(ing|ment|ers?)?|hr|people|join(us)?|work(withus)?|apply|engineering-jobs|tech-jobs)$/i;
const GENERAL_INBOX = /^(hello|info|contact|team)$/i;

function sourceTypeForPath(path: string): ContactSourceType {
  if (/^\/(careers?|jobs)/.test(path)) return 'CAREERS_PAGE';
  if (/^\/contact/.test(path)) return 'CONTACT_PAGE';
  return 'COMPANY_WEBSITE';
}

/**
 * Inboxes the company publishes on its own website (mailto links / text on the
 * careers, jobs, contact and home pages). Only role inboxes on the company's own
 * domain are returned — never personal addresses, never guesses. A general
 * address (hello@/info@/contact@) is returned only when no hiring inbox exists.
 */
export class CompanyWebsiteContactProvider implements ContactProvider {
  readonly name = 'company_website';
  readonly enabled = true;

  constructor(private readonly fetchPage: (url: string) => Promise<string | null>) {}

  async findContacts(input: ContactSearchInput): Promise<ContactCandidate[]> {
    if (!input.domain) return [];
    const domain = input.domain.replace(/^www\./, '').toLowerCase();
    const hiring = new Map<string, ContactCandidate>();
    const general = new Map<string, ContactCandidate>();
    for (const path of ['/careers', '/jobs', '/contact', '/']) {
      const url = `https://${domain}${path}`;
      const html = await this.fetchPage(url).catch(() => null);
      if (!html) continue;
      const emails = new Set<string>();
      for (const m of html.matchAll(/mailto:([^"'?\s>]+)/gi)) emails.add(decodeURIComponent(m[1]).toLowerCase());
      for (const m of html.matchAll(EMAIL_RE)) emails.add(m[0].toLowerCase());
      for (const email of emails) {
        const [local, host] = email.split('@');
        if (!host || !(host === domain || host.endsWith(`.${domain}`))) continue;
        const sourceType = sourceTypeForPath(path);
        if (HIRING_INBOX.test(local) && !hiring.has(email)) {
          hiring.set(email, {
            name: `${input.companyName} hiring team`,
            role: `Hiring inbox (published on ${url})`,
            roleCategory: 'RECRUITER',
            email,
            source: this.name,
            sourceUrl: url,
            confidence: 'VERIFIED',
            sourceType,
            verificationStatus: 'PUBLICLY_LISTED',
          });
        } else if (GENERAL_INBOX.test(local) && !general.has(email)) {
          general.set(email, {
            name: `${input.companyName}`,
            role: `General company contact (published on ${url})`,
            roleCategory: 'OTHER',
            email,
            source: this.name,
            sourceUrl: url,
            confidence: 'VERIFIED',
            sourceType,
            verificationStatus: 'PUBLICLY_LISTED',
          });
        }
      }
      if (hiring.size) break;
    }
    return hiring.size ? [...hiring.values()] : [...general.values()];
  }
}
