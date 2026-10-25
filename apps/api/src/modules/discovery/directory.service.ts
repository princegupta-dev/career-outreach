import { Inject, Injectable, Logger } from '@nestjs/common';
import type { JobProviderKind, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import { ENV, Env } from '../../config/env';
import { normalizeCompanyName } from '../../domain/dedupe';
import { FetchError, fetchJson } from '../../providers/http';

/**
 * Public startup directory used to find companies worth watching, instead of a hardcoded list.
 * Data: the open YC company dataset (https://yc-oss.github.io/api), which carries team size,
 * industry, location, website and whether the company is hiring. Nothing here is scraped.
 */
export const YC_DATASET_URL = 'https://yc-oss.github.io/api/companies/all.json';
const SOURCE = 'yc-oss';
const SYNC_TTL_SEC = 24 * 3600;
const REPROBE_AFTER_DAYS = 14;
const MIN_TEAM = 5;
const MAX_TEAM = 1000;
/** Company size we like best; probing starts there. */
const IDEAL_TEAM = 150;
const PROBE_CONCURRENCY = 4;

interface YcCompany {
  id: number;
  slug?: string;
  name: string;
  website?: string;
  team_size?: number | null;
  all_locations?: string;
  industry?: string;
  subindustry?: string;
  industries?: string[];
  batch?: string;
  isHiring?: boolean;
  nonprofit?: boolean;
  status?: string;
}

export interface DirectoryResult {
  synced: number;
  probed: number;
  withBoard: number;
  unverified: number;
  sourcesAdded: number;
  warnings: string[];
}

interface BoardHit {
  ats: JobProviderKind;
  slug: string;
  careerUrl: string;
  jobs: number;
  verified: string;
}

const domainOf = (site?: string | null) => {
  try {
    return site ? new URL(site).hostname.replace(/^www\./, '').toLowerCase() : null;
  } catch {
    return null;
  }
};
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Does `text` mention the company? Guards against a slug that belongs to a different company. */
export function mentionsCompany(company: string, text: string): boolean {
  const n = squash(normalizeCompanyName(company));
  if (n.length < 3) return false;
  const t = squash(text);
  return t.includes(n);
}

@Injectable()
export class DirectoryService {
  private readonly logger = new Logger(DirectoryService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Sync (at most daily) → probe a bounded batch of companies → turn verified boards into job sources. */
  async refresh(userId: string): Promise<DirectoryResult> {
    const out: DirectoryResult = { synced: 0, probed: 0, withBoard: 0, unverified: 0, sourcesAdded: 0, warnings: [] };
    if (this.env.DIRECTORY_ENABLED !== 'true') return out;
    try {
      out.synced = await this.sync();
    } catch (e) {
      out.warnings.push(`Startup directory sync failed: ${(e as Error).message.slice(0, 160)}`);
    }
    try {
      const { warnings, ...counts } = await this.probe(this.env.DIRECTORY_PROBE_BATCH);
      Object.assign(out, counts);
      out.warnings.push(...warnings);
    } catch (e) {
      out.warnings.push(`Startup directory probe failed: ${(e as Error).message.slice(0, 160)}`);
    }
    out.sourcesAdded = await this.promote(userId);
    return out;
  }

  /** Upsert hiring companies from the YC dataset. Returns how many were seen (0 when synced within 24h). */
  async sync(force = false): Promise<number> {
    const key = `directory:synced:${SOURCE}`;
    if (!force && (await this.redis.client.get(key))) return 0;
    const all = await fetchJson<YcCompany[]>(YC_DATASET_URL, { maxBytes: 60_000_000, timeoutMs: 60_000 });
    if (!Array.isArray(all)) throw new FetchError('Unexpected directory format');
    const fetchedAt = new Date().toISOString();
    const rows = all.filter((c) => c.isHiring && !c.nonprofit && c.name && (c.team_size == null || (c.team_size >= MIN_TEAM && c.team_size <= MAX_TEAM)));
    const ids = rows.map((c) => String(c.id));
    const known = new Set((await this.prisma.directoryCompany.findMany({ where: { source: SOURCE, externalId: { in: ids } }, select: { externalId: true } })).map((r) => r.externalId));
    const fresh = rows.filter((c) => !known.has(String(c.id)));
    if (fresh.length) {
      await this.prisma.directoryCompany.createMany({
        skipDuplicates: true,
        data: fresh.map((c) => ({
          source: SOURCE,
          externalId: String(c.id),
          name: c.name.trim(),
          website: c.website ?? null,
          domain: domainOf(c.website),
          teamSize: c.team_size ?? null,
          location: c.all_locations ?? null,
          category: [c.industry, c.subindustry].filter(Boolean).join(' / ') || null,
          industries: (c.industries ?? []) as Prisma.InputJsonValue,
          provenance: { source: SOURCE, url: YC_DATASET_URL, ycSlug: c.slug ?? null, batch: c.batch ?? null, fetchedAt } as Prisma.InputJsonValue,
        })),
      });
    }
    await this.prisma.directoryCompany.updateMany({ where: { source: SOURCE, externalId: { in: ids } }, data: { lastSeenAt: new Date() } });
    await this.redis.client.set(key, fetchedAt, 'EX', SYNC_TTL_SEC);
    this.logger.log({ msg: 'Directory synced', source: SOURCE, listed: all.length, hiring: rows.length, added: fresh.length });
    return rows.length;
  }

  /** Probe the next `limit` companies (never probed first, then stale misses), nearest the ideal size first. */
  async probe(limit: number): Promise<Pick<DirectoryResult, 'probed' | 'withBoard' | 'unverified' | 'warnings'>> {
    const out = { probed: 0, withBoard: 0, unverified: 0, warnings: [] as string[] };
    if (limit <= 0) return out;
    const staleBefore = new Date(Date.now() - REPROBE_AFTER_DAYS * 86_400_000);
    const due = await this.prisma.directoryCompany.findMany({
      where: { source: SOURCE, OR: [{ status: 'PENDING' }, { status: 'NO_BOARD', probedAt: { lt: staleBefore } }] },
      orderBy: [{ probedAt: { sort: 'asc', nulls: 'first' } }],
      take: limit * 4,
    });
    const queue = due.sort((a, b) => Number(a.probedAt != null) - Number(b.probedAt != null) || Math.abs((a.teamSize ?? 9999) - IDEAL_TEAM) - Math.abs((b.teamSize ?? 9999) - IDEAL_TEAM)).slice(0, limit);
    let transient = 0;
    const worker = async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        out.probed++;
        const slugs = this.slugCandidates(c);
        let hit: BoardHit | null = null;
        let sawUnverified: string | null = null;
        let failed = false;
        for (const slug of slugs) {
          for (const attempt of [this.greenhouse, this.ashby, this.lever]) {
            try {
              const r = await attempt.call(this, slug, c.name);
              if (r && r.verified) {
                hit = r;
                break;
              }
              if (r) sawUnverified = `${r.ats}/${r.slug}`;
            } catch (e) {
              if (!(e instanceof FetchError && e.status === 404)) failed = true;
            }
          }
          if (hit) break;
        }
        if (hit) {
          out.withBoard++;
          await this.prisma.directoryCompany.update({
            where: { id: c.id },
            data: { status: 'HAS_BOARD', ats: hit.ats, atsSlug: hit.slug, careerUrl: hit.careerUrl, probedAt: new Date(), provenance: { ...((c.provenance as object) ?? {}), board: { ats: hit.ats, slug: hit.slug, jobs: hit.jobs, verified: hit.verified, probedAt: new Date().toISOString() } } as Prisma.InputJsonValue },
          });
        } else if (failed) {
          transient++; // network/5xx: try again next run instead of recording a false "no board"
          await this.prisma.directoryCompany.update({ where: { id: c.id }, data: { probedAt: new Date() } });
        } else {
          if (sawUnverified) out.unverified++;
          await this.prisma.directoryCompany.update({
            where: { id: c.id },
            data: { status: 'NO_BOARD', probedAt: new Date(), provenance: { ...((c.provenance as object) ?? {}), board: sawUnverified ? { rejected: `${sawUnverified} exists but does not mention "${c.name}"` } : null } as Prisma.InputJsonValue },
          });
        }
      }
    };
    await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker));
    if (transient) out.warnings.push(`Startup directory: ${transient} of ${out.probed} companies could not be probed (network/server errors); they will be retried`);
    return out;
  }

  /** Verified boards become job sources for this user, with provenance in the source config. */
  async promote(userId: string): Promise<number> {
    const boards = await this.prisma.directoryCompany.findMany({ where: { source: SOURCE, status: 'HAS_BOARD', ats: { not: null }, atsSlug: { not: null } } });
    if (!boards.length) return 0;
    const existing = await this.prisma.jobSource.findMany({ where: { userId, provider: { in: ['GREENHOUSE', 'ASHBY', 'LEVER'] } }, select: { provider: true, config: true } });
    const watched = new Set(existing.map((s) => `${s.provider}:${String((s.config as { boardToken?: string }).boardToken ?? '').toLowerCase()}`));
    const data = boards
      .filter((b) => !watched.has(`${b.ats}:${b.atsSlug!.toLowerCase()}`))
      .map((b) => ({
        userId,
        provider: b.ats!,
        name: b.name,
        isDefault: false,
        config: {
          boardToken: b.atsSlug,
          companyName: b.name,
          domain: b.domain,
          teamSize: b.teamSize,
          category: b.category,
          careerUrl: b.careerUrl,
          provenance: { ...((b.provenance as object) ?? {}), directoryId: b.id },
        } as Prisma.InputJsonValue,
      }));
    if (!data.length) return 0;
    const r = await this.prisma.jobSource.createMany({ data, skipDuplicates: true });
    return r.count;
  }

  private slugCandidates(c: { name: string; domain: string | null; provenance: unknown }): string[] {
    const ycSlug = (c.provenance as { ycSlug?: string } | null)?.ycSlug;
    const label = c.domain?.split('.')[0];
    const plain = squash(c.name);
    const hyphen = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return [...new Set([label, ycSlug, plain, hyphen].filter((s): s is string => !!s && /^[a-z0-9][a-z0-9-]{1,60}$/.test(s)))];
  }

  private async greenhouse(slug: string, company: string): Promise<BoardHit | null> {
    const [board, list] = await Promise.all([
      fetchJson<{ name?: string }>(`https://boards-api.greenhouse.io/v1/boards/${slug}`),
      fetchJson<{ jobs?: unknown[] }>(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, { maxBytes: 20_000_000 }),
    ]);
    if (!list.jobs?.length) return null;
    const named = !!board.name && (mentionsCompany(company, board.name) || mentionsCompany(board.name, company));
    return { ats: 'GREENHOUSE', slug, careerUrl: `https://boards.greenhouse.io/${slug}`, jobs: list.jobs.length, verified: named ? 'board-name' : '' };
  }

  private async ashby(slug: string, company: string): Promise<BoardHit | null> {
    const d = await fetchJson<{ jobs?: Array<{ title?: string; descriptionPlain?: string }> }>(`https://api.ashbyhq.com/posting-api/job-board/${slug}`, { maxBytes: 20_000_000 });
    if (!d.jobs?.length) return null;
    const named = d.jobs.slice(0, 8).some((j) => mentionsCompany(company, `${j.title ?? ''} ${j.descriptionPlain ?? ''}`));
    return { ats: 'ASHBY', slug, careerUrl: `https://jobs.ashbyhq.com/${slug}`, jobs: d.jobs.length, verified: named ? 'postings-mention-company' : '' };
  }

  private async lever(slug: string, company: string): Promise<BoardHit | null> {
    const d = await fetchJson<Array<{ text?: string; descriptionPlain?: string }>>(`https://api.lever.co/v0/postings/${slug}?mode=json`, { maxBytes: 20_000_000 });
    if (!Array.isArray(d) || !d.length) return null;
    const named = d.slice(0, 8).some((j) => mentionsCompany(company, `${j.text ?? ''} ${j.descriptionPlain ?? ''}`));
    return { ats: 'LEVER', slug, careerUrl: `https://jobs.lever.co/${slug}`, jobs: d.length, verified: named ? 'postings-mention-company' : '' };
  }
}
