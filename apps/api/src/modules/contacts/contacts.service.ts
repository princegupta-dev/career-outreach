import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ContactConfidence, ContactRole } from '@prisma/client';
import { AuditService } from '../../common/audit.service';
import { DomainError } from '../../common/http';
import { PrismaService } from '../../common/prisma.service';
import { ENV, Env } from '../../config/env';
import { categorizeRole, rankContacts } from '../../domain/contacts/rank';
import { normalizeEmail } from '../../domain/dedupe';
import { isValidEmail } from '../../domain/outreach/guardrails';
import { CompanyWebsiteContactProvider, ContactCandidate, ContactProvider, HunterContactProvider, JobPostingContactProvider } from '../../providers/contacts/contact-provider';
import { httpFetch, isAllowedByRobots } from '../../providers/http';
import { RedisService } from '../../common/redis.service';
import { ApplicationsService } from '../applications/applications.service';

export interface ContactInput {
  name: string;
  role?: string | null;
  roleCategory?: ContactRole;
  email?: string | null;
  linkedinUrl?: string | null;
  notes?: string | null;
  confidence?: ContactConfidence;
  sourceUrl?: string | null;
}

@Injectable()
export class ContactsService {
  private readonly logger = new Logger(ContactsService.name);
  readonly providers: ContactProvider[];

  constructor(
    @Inject(ENV) env: Env,
    private readonly prisma: PrismaService,
    private readonly applications: ApplicationsService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {
    this.providers = [
      new JobPostingContactProvider(),
      new CompanyWebsiteContactProvider((url) => this.fetchPublicPage(url)),
      new HunterContactProvider(env.HUNTER_API_KEY || undefined),
    ];
  }

  /** robots.txt-respecting page fetch, cached for 7 days per URL. */
  private async fetchPublicPage(url: string): Promise<string | null> {
    const key = `page-cache:${url}`;
    const cached = await this.redis.client.get(key);
    if (cached !== null) return cached || null;
    let html = '';
    try {
      if (await isAllowedByRobots(url)) {
        const r = await httpFetch(url, { timeoutMs: 8000, maxBytes: 1_500_000 });
        // Keep only email-like strings (all the provider needs) to keep the cache small.
        if (r.status < 400 && /html/i.test(r.contentType)) html = (r.text.match(/mailto:[^"'\s>]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).join('\n');
      }
    } catch {
      html = '';
    }
    await this.redis.client.set(key, html, 'EX', 7 * 86_400);
    return html || null;
  }

  /** Store contacts that came with a job posting (e.g. emails in a HN post). */
  async upsertCandidates(userId: string, companyId: string, candidates: ContactCandidate[]): Promise<number> {
    let n = 0;
    for (const c of candidates) {
      try {
        await this.upsert(userId, companyId, c);
        n++;
      } catch {
        /* invalid address → skip */
      }
    }
    return n;
  }

  private async upsert(userId: string, companyId: string, c: ContactCandidate) {
    const emailNormalized = c.email ? normalizeEmail(c.email) : null;
    if (emailNormalized && !isValidEmail(emailNormalized)) throw new DomainError(`"${c.email}" is not a valid email address`, 400);
    if (emailNormalized) {
      const existing = await this.prisma.contact.findUnique({ where: { userId_companyId_emailNormalized: { userId, companyId, emailNormalized } } });
      if (existing) {
        // Never downgrade a verified contact; only fill gaps.
        return this.prisma.contact.update({
          where: { id: existing.id },
          data: {
            deletedAt: null,
            role: existing.role ?? c.role ?? null,
            roleCategory: existing.roleCategory === 'OTHER' ? c.roleCategory : existing.roleCategory,
            linkedinUrl: existing.linkedinUrl ?? c.linkedinUrl ?? null,
            confidence: rankConfidence(existing.confidence) >= rankConfidence(c.confidence) ? existing.confidence : c.confidence,
          },
        });
      }
    }
    return this.prisma.contact.create({
      data: {
        userId,
        companyId,
        name: c.name.trim(),
        role: c.role ?? null,
        roleCategory: c.roleCategory,
        email: c.email?.trim() ?? null,
        emailNormalized,
        source: c.source,
        sourceUrl: c.sourceUrl ?? null,
        confidence: c.confidence,
        linkedinUrl: c.linkedinUrl ?? null,
      },
    });
  }

  async create(userId: string, companyId: string, input: ContactInput) {
    const company = await this.prisma.company.findFirst({ where: { id: companyId, userId } });
    if (!company) throw new NotFoundException('Company not found');
    const contact = await this.upsert(userId, companyId, {
      name: input.name,
      role: input.role,
      roleCategory: input.roleCategory ?? categorizeRole(input.role),
      email: input.email,
      linkedinUrl: input.linkedinUrl,
      source: 'manual',
      sourceUrl: input.sourceUrl ?? null,
      // Manually entered contacts are UNVERIFIED unless the user says otherwise.
      confidence: input.confidence ?? 'UNVERIFIED',
    });
    if (input.notes) await this.prisma.contact.update({ where: { id: contact.id }, data: { notes: input.notes } });
    await this.audit.log('contact.created', { userId, entityType: 'contact', entityId: contact.id, metadata: { source: 'manual' } });
    return contact;
  }

  async update(userId: string, id: string, input: Partial<ContactInput>) {
    const contact = await this.prisma.contact.findFirst({ where: { id, userId, deletedAt: null } });
    if (!contact) throw new NotFoundException('Contact not found');
    const emailNormalized = input.email !== undefined ? (input.email ? normalizeEmail(input.email) : null) : undefined;
    if (emailNormalized && !isValidEmail(emailNormalized)) throw new DomainError('Invalid email address', 400);
    return this.prisma.contact.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.role !== undefined ? { role: input.role, roleCategory: input.roleCategory ?? categorizeRole(input.role) } : {}),
        ...(input.roleCategory ? { roleCategory: input.roleCategory } : {}),
        ...(input.email !== undefined ? { email: input.email, emailNormalized } : {}),
        ...(input.linkedinUrl !== undefined ? { linkedinUrl: input.linkedinUrl } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.confidence ? { confidence: input.confidence } : {}),
      },
    });
  }

  async remove(userId: string, id: string): Promise<void> {
    const contact = await this.prisma.contact.findFirst({ where: { id, userId } });
    if (!contact) throw new NotFoundException('Contact not found');
    await this.prisma.contact.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  /** Ranked contacts for a job's company (best first). */
  async rankedForJob(userId: string, jobId: string) {
    const job = await this.prisma.job.findFirst({ where: { id: jobId, userId }, include: { company: true } });
    if (!job) throw new NotFoundException('Job not found');
    const contacts = await this.prisma.contact.findMany({ where: { userId, companyId: job.companyId, deletedAt: null } });
    return rankContacts(contacts, job.company.size).map((r) => ({ ...r.contact, rankScore: r.score, rankReason: r.reason }));
  }

  /** Run legitimate contact providers, store results, pick the best contact. */
  async discover(userId: string, jobId: string) {
    const job = await this.prisma.job.findFirst({ where: { id: jobId, userId }, include: { company: true, application: true } });
    if (!job) throw new NotFoundException('Job not found');
    const found: string[] = [];
    const errors: string[] = [];
    for (const provider of this.providers.filter((p) => p.enabled)) {
      try {
        const candidates = await provider.findContacts({ companyName: job.company.name, domain: job.company.domain, jobDescription: job.description, jobUrl: job.url });
        for (const c of candidates) found.push((await this.upsert(userId, job.companyId, c)).id);
      } catch (e) {
        errors.push(`${provider.name}: ${(e as Error).message}`);
        this.logger.warn({ msg: 'Contact provider failed', provider: provider.name, error: (e as Error).message });
      }
    }
    const ranked = await this.rankedForJob(userId, jobId);
    const best = ranked.find((c) => c.email);
    if (job.application && !job.application.contactId && best) {
      await this.prisma.application.update({ where: { id: job.application.id }, data: { contactId: best.id } });
      await this.applications.autoAdvance(job.application.id, 'CONTACT_FOUND');
    }
    return {
      contacts: ranked,
      newOrUpdated: found.length,
      selectedContactId: best?.id ?? null,
      providers: this.providers.map((p) => ({ name: p.name, enabled: p.enabled })),
      errors,
    };
  }

  async assignToApplication(userId: string, applicationId: string, contactId: string) {
    const app = await this.applications.get(userId, applicationId);
    const contact = await this.prisma.contact.findFirst({ where: { id: contactId, userId, deletedAt: null } });
    if (!contact) throw new NotFoundException('Contact not found');
    if (contact.companyId !== app.job.companyId) throw new DomainError('Contact belongs to a different company', 400);
    await this.prisma.application.update({ where: { id: applicationId }, data: { contactId } });
    await this.applications.autoAdvance(applicationId, 'CONTACT_FOUND');
    return contact;
  }
}

function rankConfidence(c: ContactConfidence): number {
  return { VERIFIED: 3, LIKELY: 2, UNVERIFIED: 1, UNKNOWN: 0 }[c];
}
