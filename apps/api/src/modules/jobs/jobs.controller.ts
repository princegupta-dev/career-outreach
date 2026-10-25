import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { JobProviderKind, Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { AuthUser, CurrentUser, DomainError, RateLimit, ZodPipe } from '../../common/http';
import { PrismaService } from '../../common/prisma.service';
import { QueueService } from '../queues/queues';
import { JobsService } from './jobs.service';

const manualSchema = z.object({
  title: z.string().trim().min(2).max(300),
  companyName: z.string().trim().min(1).max(200),
  description: z.string().trim().min(50, 'Paste the full job description (min 50 characters)').max(60_000),
  location: z.string().trim().max(200).nullish(),
  url: z.string().trim().url().max(2000).nullish().or(z.literal('').transform(() => null)),
  companyWebsite: z.string().trim().max(500).nullish(),
  salaryText: z.string().trim().max(200).nullish(),
  remote: z.boolean().nullish(),
  mode: z.enum(['manual', 'paste']).default('paste'),
});

const urlSchema = z.object({ url: z.string().trim().url().max(2000) });

const listSchema = z.object({
  search: z.string().max(200).optional(),
  status: z.string().max(40).optional(),
  recommendation: z.enum(['STRONG_APPLY', 'APPLY', 'CONSIDER', 'LOW_PRIORITY', 'SKIP']).optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  stage: z.enum(['DISCOVERED', 'SHORTLISTED', 'PREPARING', 'READY_FOR_REVIEW', 'APPROVED', 'APPLIED', 'REPLIED', 'INTERVIEW', 'OFFER', 'REJECTED', 'SKIPPED', 'ARCHIVED']).optional(),
  verdict: z.enum(['STRONG_MATCH', 'GOOD_MATCH', 'REVIEW_MANUALLY', 'NOT_RECOMMENDED']).optional(),
  source: z.string().max(30).optional(),
  location: z.enum(['remote', 'india', 'other']).optional(),
  companySize: z.enum(['EARLY_STARTUP', 'GROWTH_STARTUP', 'MID_MARKET', 'ENTERPRISE', 'UNKNOWN']).optional(),
  needsAction: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  sort: z.enum(['score', 'recent', 'priority']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

const sourceSchema = z.object({
  provider: z.enum(['GREENHOUSE', 'LEVER', 'ASHBY']),
  name: z.string().trim().min(1).max(100),
  boardToken: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,100}$/, 'Board token: letters, numbers, dot, dash, underscore'),
  companyName: z.string().trim().max(200).optional(),
  enabled: z.boolean().default(true),
});

@Controller()
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
    private readonly audit: AuditService,
  ) {}

  @Get('jobs')
  list(@CurrentUser() user: AuthUser, @Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    return this.jobs.list(user.id, q);
  }

  @Post('jobs/manual')
  create(@CurrentUser() user: AuthUser, @Body(new ZodPipe(manualSchema)) body: z.infer<typeof manualSchema>) {
    return this.jobs.createManual(user.id, body, body.mode === 'manual' ? 'MANUAL' : 'PASTE');
  }

  @Post('jobs/import-url')
  @RateLimit({ name: 'import-url', limit: 30, windowSec: 60 })
  importUrl(@CurrentUser() user: AuthUser, @Body(new ZodPipe(urlSchema)) body: z.infer<typeof urlSchema>) {
    return this.jobs.importFromUrl(user.id, body.url);
  }

  @Get('jobs/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.get(user.id, id);
  }

  @Post('jobs/:id/rescore')
  @HttpCode(200)
  async rescore(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.jobs.get(user.id, id);
    return this.jobs.score(id, true);
  }

  @Post('jobs/rescore-all')
  @HttpCode(200)
  rescoreAll(@CurrentUser() user: AuthUser) {
    return this.jobs.rescoreAll(user.id);
  }

  @Post('jobs/:id/analyze')
  @HttpCode(200)
  @RateLimit({ name: 'ai', limit: 20, windowSec: 60 })
  analyze(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ force: z.boolean().optional() }))) body: { force?: boolean }) {
    return this.jobs.analyze(user.id, id, body.force);
  }

  @Delete('jobs/:id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.jobs.remove(user.id, id);
  }

  // ─── Job sources (discovery) ───────────────────────────────────────────────

  @Get('job-sources')
  sources(@CurrentUser() user: AuthUser) {
    return this.prisma.jobSource.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' }, include: { _count: { select: { jobs: true } } } });
  }

  @Post('job-sources')
  async createSource(@CurrentUser() user: AuthUser, @Body(new ZodPipe(sourceSchema)) body: z.infer<typeof sourceSchema>) {
    const source = await this.prisma.jobSource.create({
      data: {
        userId: user.id,
        provider: body.provider as JobProviderKind,
        name: body.name,
        enabled: body.enabled,
        config: { boardToken: body.boardToken, ...(body.companyName ? { companyName: body.companyName } : {}) } as Prisma.InputJsonValue,
      },
    });
    await this.audit.log('job_source.created', { userId: user.id, entityType: 'job_source', entityId: source.id });
    return source;
  }

  @Patch('job-sources/:id')
  async updateSource(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ enabled: z.boolean() }))) body: { enabled: boolean }) {
    const s = await this.prisma.jobSource.findFirst({ where: { id, userId: user.id } });
    if (!s) throw new DomainError('Job source not found', 404);
    return this.prisma.jobSource.update({ where: { id }, data: { enabled: body.enabled } });
  }

  @Delete('job-sources/:id')
  @HttpCode(204)
  async deleteSource(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.prisma.jobSource.deleteMany({ where: { id, userId: user.id } });
  }

  /** Runs discovery now and returns the pipeline funnel (fetched → filtered → new → qualified → AI). */
  @Post('job-sources/:id/run')
  @HttpCode(200)
  @RateLimit({ name: 'discovery', limit: 10, windowSec: 60 })
  run(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.runSource(user.id, id);
  }

  @Post('job-sources/run-all')
  @HttpCode(202)
  async runAll(@CurrentUser() user: AuthUser) {
    const sources = await this.prisma.jobSource.findMany({ where: { userId: user.id, enabled: true } });
    for (const s of sources) await this.queues.discover({ userId: user.id, sourceId: s.id });
    return { queued: sources.length };
  }
}
