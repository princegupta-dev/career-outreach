import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser, ZodPipe } from '../../common/http';
import { PIPELINE_STATUSES } from '../../domain/applications/state-machine';
import { SEND_MODE_CONFIRMATION, SEND_MODES } from '../../domain/settings';
import { ApplicationsService } from './applications.service';
import { PipelineService } from './pipeline.service';
import { SettingsService } from '../settings/settings.service';

const listSchema = z.object({
  status: z.enum(PIPELINE_STATUSES).optional(),
  search: z.string().max(200).optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  freshness: z.enum(['24h', '72h', '7d']).optional(),
  sort: z.enum(['score', 'recent', 'posted']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

const appliedSchema = z.object({ appliedAt: z.coerce.date().optional(), note: z.string().max(2000).optional() });
const skipSchema = z.object({ reason: z.string().max(500).optional() });

const sendPolicySchema = z.object({
  sendMode: z.enum(SEND_MODES).optional(),
  /** Required (exact text) when switching to AUTO_SEND. */
  confirmation: z.string().max(200).optional(),
  dailyLimit: z.number().int().min(1).max(100).optional(),
  dailyInitialLimit: z.number().int().min(1).max(100).optional(),
  hourlyLimit: z.number().int().min(1).max(30).optional(),
  perDomainDailyLimit: z.number().int().min(1).max(10).optional(),
  minMinutesBetweenSends: z.number().int().min(0).max(240).optional(),
  maxJitterSeconds: z.number().int().min(0).max(900).optional(),
  autoSendMinScore: z.number().int().min(50).max(100).optional(),
  followupAutoSend: z.boolean().optional(),
});

/**
 * Dashboard API for the job-search pipeline:
 *   GET  /pipeline/summary                     counts per status, today's send budget, freshness
 *   GET  /pipeline/applications                filterable application list (status, score, freshness)
 *   GET  /pipeline/applications/:id            one application with score breakdown, contact, email, follow-ups
 *   POST /pipeline/applications/:id/applied    record a portal application
 *   POST /pipeline/applications/:id/skip       mark as skipped
 *   GET  /pipeline/emails                      sent-email log with reply status
 *   GET  /pipeline/send-policy                 send mode + rate limits
 *   PUT  /pipeline/send-policy                 change them (AUTO_SEND needs explicit confirmation)
 */
@Controller('pipeline')
export class PipelineController {
  constructor(
    private readonly pipeline: PipelineService,
    private readonly applications: ApplicationsService,
    private readonly settings: SettingsService,
  ) {}

  @Get('summary')
  summary(@CurrentUser() user: AuthUser) {
    return this.pipeline.summary(user.id);
  }

  @Get('applications')
  list(@CurrentUser() user: AuthUser, @Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    return this.pipeline.list(user.id, q);
  }

  @Get('applications/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.pipeline.get(user.id, id);
  }

  @Post('applications/:id/applied')
  @HttpCode(200)
  applied(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(appliedSchema)) body: z.infer<typeof appliedSchema>) {
    return this.pipeline.markApplied(user.id, id, body.appliedAt, body.note);
  }

  @Post('applications/:id/skip')
  @HttpCode(200)
  async skip(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(skipSchema)) body: z.infer<typeof skipSchema>) {
    await this.applications.transition(user.id, id, 'SKIPPED', body.reason ? `Skipped: ${body.reason}` : undefined);
    return this.pipeline.get(user.id, id);
  }

  @Get('emails')
  emails(@CurrentUser() user: AuthUser, @Query(new ZodPipe(z.object({ page: z.coerce.number().int().min(1).optional(), pageSize: z.coerce.number().int().min(1).max(100).optional() }))) q: { page?: number; pageSize?: number }) {
    return this.pipeline.sentEmails(user.id, q);
  }

  @Get('send-policy')
  async policy(@CurrentUser() user: AuthUser) {
    const s = await this.settings.get(user.id);
    return { ...s.outreach, followups: s.followups, autoSendConfirmation: SEND_MODE_CONFIRMATION };
  }

  @Put('send-policy')
  async setPolicy(@CurrentUser() user: AuthUser, @Body(new ZodPipe(sendPolicySchema)) body: z.infer<typeof sendPolicySchema>) {
    const { confirmation, followupAutoSend, ...outreach } = body;
    const s = await this.settings.update(user.id, {
      outreach: Object.fromEntries(Object.entries(outreach).filter(([, v]) => v !== undefined)),
      ...(followupAutoSend !== undefined ? { followups: { autoSend: followupAutoSend } } : {}),
      ...(confirmation ? { confirmation } : {}),
    });
    return { ...s.outreach, followups: s.followups, autoSendConfirmation: SEND_MODE_CONFIRMATION };
  }
}
