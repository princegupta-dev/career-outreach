import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser, RateLimit, ZodPipe } from '../../common/http';
import { CompaniesService } from '../companies/companies.service';
import { ApplicationsService } from '../applications/applications.service';
import { JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../../common/prisma.service';
import { ContactsService } from './contacts.service';

const ROLES = ['HIRING_MANAGER', 'ENGINEERING_MANAGER', 'TECHNICAL_RECRUITER', 'ENGINEERING_DIRECTOR', 'RECRUITER', 'HR', 'FOUNDER', 'CTO', 'ENGINEER', 'OTHER'] as const;
const CONFIDENCE = ['VERIFIED', 'LIKELY', 'UNVERIFIED', 'UNKNOWN'] as const;

const contactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().max(160).nullish(),
  roleCategory: z.enum(ROLES).optional(),
  email: z.string().trim().email().max(254).nullish().or(z.literal('').transform(() => null)),
  linkedinUrl: z.string().trim().url().max(500).nullish().or(z.literal('').transform(() => null)),
  notes: z.string().max(2000).nullish(),
  confidence: z.enum(CONFIDENCE).optional(),
  sourceUrl: z.string().trim().url().max(1000).nullish().or(z.literal('').transform(() => null)),
});

const companySchema = z.object({
  size: z.enum(['EARLY_STARTUP', 'GROWTH_STARTUP', 'MID_MARKET', 'ENTERPRISE', 'UNKNOWN']).optional(),
  companyType: z.enum(['early_stage_startup', 'growth_stage_startup', 'mid_market', 'enterprise', 'international_startup', 'remote_first']).nullish(),
  domain: z.string().trim().max(253).nullish(),
  website: z.string().trim().max(500).nullish(),
  description: z.string().max(2000).nullish(),
});

const statusSchema = z.object({
  status: z.enum(['DISCOVERED', 'QUALIFIED', 'SHORTLISTED', 'CONTACT_FOUND', 'RESUME_READY', 'EMAIL_READY', 'EMAIL_SENT', 'WAITING_FOR_REPLY', 'FOLLOWUP_SCHEDULED', 'REPLIED', 'INTERVIEW', 'REJECTED', 'OFFER', 'CLOSED']),
  note: z.string().max(2000).optional(),
});

@Controller()
export class ContactsController {
  constructor(
    private readonly contacts: ContactsService,
    private readonly companies: CompaniesService,
    private readonly applications: ApplicationsService,
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('jobs/:id/contacts')
  ranked(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.contacts.rankedForJob(user.id, id);
  }

  @Post('jobs/:id/contacts/discover')
  @HttpCode(200)
  @RateLimit({ name: 'contact-discovery', limit: 20, windowSec: 60 })
  discover(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.contacts.discover(user.id, id);
  }

  @Post('companies/:id/contacts')
  create(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(contactSchema)) body: z.infer<typeof contactSchema>) {
    return this.contacts.create(user.id, id, body);
  }

  @Patch('contacts/:id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(contactSchema.partial())) body: Partial<z.infer<typeof contactSchema>>) {
    return this.contacts.update(user.id, id, body);
  }

  @Delete('contacts/:id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.contacts.remove(user.id, id);
  }

  @Post('applications/:id/contact')
  @HttpCode(200)
  assign(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ contactId: z.string().uuid() }))) body: { contactId: string }) {
    return this.contacts.assignToApplication(user.id, id, body.contactId);
  }

  // ─── Companies ─────────────────────────────────────────────────────────────

  @Get('companies')
  listCompanies(@CurrentUser() user: AuthUser) {
    return this.companies.list(user.id);
  }

  @Patch('companies/:id')
  async updateCompany(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(companySchema)) body: z.infer<typeof companySchema>) {
    const company = await this.companies.update(user.id, id, body);
    // Company size/type are scoring inputs.
    const jobs = await this.prisma.job.findMany({ where: { companyId: id, deletedAt: null }, select: { id: true } });
    for (const j of jobs) await this.jobs.score(j.id);
    return company;
  }

  @Post('companies/:id/research')
  @HttpCode(200)
  research(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.companies.research(user.id, id, true);
  }

  // ─── Applications ──────────────────────────────────────────────────────────

  @Get('applications/pipeline')
  pipeline(@CurrentUser() user: AuthUser) {
    return this.applications.pipelineCounts(user.id);
  }

  @Post('applications/:id/status')
  @HttpCode(200)
  status(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(statusSchema)) body: z.infer<typeof statusSchema>) {
    return this.applications.transition(user.id, id, body.status, body.note);
  }
}
