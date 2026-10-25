import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { CompanySize, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { sizeFromTeam } from '../../domain/company-size';
import { normalizeCompanyName } from '../../domain/dedupe';
import { httpFetch, isAllowedByRobots } from '../../providers/http';
import { extractCompanyMeta } from '../../providers/jobs/html-extract';
import type { CompanyMeta } from '../../providers/jobs/job-provider.interface';

export interface CompanyFact {
  text: string;
  sourceUrl: string | null;
  fetchedAt: string;
}

const RESEARCH_TTL_MS = 30 * 24 * 3600 * 1000;

function domainFrom(input?: string | null): string | null {
  if (!input) return null;
  try {
    const u = new URL(/^https?:\/\//.test(input) ? input : `https://${input}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

@Injectable()
export class CompaniesService {
  private readonly logger = new Logger(CompaniesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findOrCreate(userId: string, name: string, extra: { website?: string | null; domain?: string | null; location?: string | null; meta?: CompanyMeta | null } = {}) {
    const normalizedName = normalizeCompanyName(name) || name.toLowerCase();
    const domain = domainFrom(extra.domain ?? extra.website);
    const meta = extra.meta ?? null;
    const metaData = {
      teamSize: meta?.teamSize ?? null,
      category: meta?.category ?? null,
      careerUrl: meta?.careerUrl ?? null,
      provenance: (meta?.provenance ?? undefined) as Prisma.InputJsonValue | undefined,
    };
    const existing = await this.prisma.company.findUnique({ where: { userId_normalizedName: { userId, normalizedName } } });
    if (existing) {
      // Fill gaps only; never overwrite what the user or an earlier source already established.
      const fill: Prisma.CompanyUpdateInput = {};
      if (!existing.domain && domain) Object.assign(fill, { domain, website: existing.website ?? extra.website ?? null });
      if (existing.deletedAt) fill.deletedAt = null;
      if (existing.teamSize == null && metaData.teamSize) {
        fill.teamSize = metaData.teamSize;
        if (existing.size === 'UNKNOWN') fill.size = sizeFromTeam(metaData.teamSize);
      }
      if (!existing.category && metaData.category) fill.category = metaData.category;
      if (!existing.careerUrl && metaData.careerUrl) fill.careerUrl = metaData.careerUrl;
      if (!existing.provenance && metaData.provenance) fill.provenance = metaData.provenance;
      return Object.keys(fill).length ? this.prisma.company.update({ where: { id: existing.id }, data: fill }) : existing;
    }
    return this.prisma.company.create({
      data: {
        userId,
        name: name.trim(),
        normalizedName,
        domain,
        website: extra.website ?? (domain ? `https://${domain}` : null),
        location: extra.location ?? null,
        size: sizeFromTeam(metaData.teamSize),
        ...metaData,
      },
    });
  }

  async update(userId: string, id: string, data: { size?: CompanySize; companyType?: string | null; domain?: string | null; website?: string | null; description?: string | null }) {
    const company = await this.prisma.company.findFirst({ where: { id, userId } });
    if (!company) throw new NotFoundException('Company not found');
    const domain = data.domain !== undefined ? domainFrom(data.domain) : undefined;
    return this.prisma.company.update({ where: { id }, data: { ...data, ...(domain !== undefined ? { domain } : {}) } });
  }

  /**
   * Verified facts only: what the company says about itself on its homepage
   * (meta description), with the source URL. Cached for 30 days.
   */
  async research(userId: string, id: string, force = false): Promise<CompanyFact[]> {
    const company = await this.prisma.company.findFirst({ where: { id, userId } });
    if (!company) throw new NotFoundException('Company not found');
    if (!force && company.researchedAt && Date.now() - company.researchedAt.getTime() < RESEARCH_TTL_MS) {
      return (company.research as unknown as CompanyFact[]) ?? [];
    }
    const facts: CompanyFact[] = [];
    const site = company.website ?? (company.domain ? `https://${company.domain}` : null);
    if (site) {
      try {
        if (await isAllowedByRobots(site)) {
          const res = await httpFetch(site, { timeoutMs: 10_000, maxBytes: 1_500_000 });
          if (res.status < 400 && /html/.test(res.contentType)) {
            const meta = extractCompanyMeta(res.text);
            if (meta.description) facts.push({ text: meta.description.slice(0, 300), sourceUrl: site, fetchedAt: new Date().toISOString() });
          }
        }
      } catch (e) {
        this.logger.warn({ msg: 'Company research fetch failed', companyId: id, error: (e as Error).message });
      }
    }
    await this.prisma.company.update({
      where: { id },
      data: { research: facts as unknown as Prisma.InputJsonValue, researchedAt: new Date(), description: company.description ?? facts[0]?.text ?? null },
    });
    return facts;
  }

  async list(userId: string) {
    return this.prisma.company.findMany({
      where: { userId, deletedAt: null },
      orderBy: { name: 'asc' },
      include: { _count: { select: { jobs: true, contacts: true } } },
    });
  }
}
