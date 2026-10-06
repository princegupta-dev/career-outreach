import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthUser, CurrentUser, DomainError, RateLimit, ZodPipe } from '../../common/http';
import { PrismaService } from '../../common/prisma.service';
import { ENV, Env } from '../../config/env';
import { AnalyticsService } from '../analytics/analytics.service';
import { QueueService } from '../queues/queues';
import { EmailAccountsService } from './email-accounts.service';
import { EmailSyncService } from './email-sync.service';
import { OutreachService } from '../outreach/outreach.service';

const simulateSchema = z.object({
  outreachId: z.string().uuid(),
  kind: z.enum(['reply', 'auto_reply', 'bounce']).default('reply'),
  body: z.string().max(2000).default("Thanks for reaching out — let's schedule a call next week."),
});

@Controller('email')
export class EmailController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly accounts: EmailAccountsService,
    private readonly sync: EmailSyncService,
    private readonly queues: QueueService,
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
    private readonly outreach: OutreachService,
  ) {}

  @Get('status')
  status(@CurrentUser() user: AuthUser) {
    return this.accounts.status(user.id);
  }

  @Post('gmail/connect')
  @HttpCode(200)
  @RateLimit({ name: 'oauth', limit: 10, windowSec: 60 })
  connect(@CurrentUser() user: AuthUser) {
    return this.accounts.startGmailConnect(user.id);
  }

  /** Google redirects here (through the web app's /api proxy). */
  @Get('gmail/callback')
  async callback(
    @CurrentUser() user: AuthUser,
    @Query(new ZodPipe(z.object({ code: z.string().max(2000).optional(), state: z.string().max(200).optional(), error: z.string().max(200).optional() }))) q: { code?: string; state?: string; error?: string },
    @Res() res: Response,
  ) {
    const back = new URL('/settings', this.env.APP_URL);
    try {
      if (q.error || !q.code || !q.state) throw new DomainError(q.error === 'access_denied' ? 'Gmail access was denied' : 'Missing authorization code', 400);
      const account = await this.accounts.completeGmailConnect(user.id, q.code, q.state);
      back.searchParams.set('gmail', 'connected');
      back.searchParams.set('email', account.email);
    } catch (e) {
      back.searchParams.set('gmail', 'error');
      back.searchParams.set('message', (e as Error).message.slice(0, 200));
    }
    res.redirect(302, back.toString());
  }

  @Delete('accounts/:id')
  @HttpCode(204)
  async disconnect(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.accounts.disconnect(user.id, id);
  }

  /** Check for replies now (also runs on a schedule in the worker). */
  @Post('sync')
  @HttpCode(200)
  @RateLimit({ name: 'sync', limit: 6, windowSec: 60 })
  async syncNow(@CurrentUser() user: AuthUser) {
    const drafts = await this.outreach.reconcileDrafts(user.id);
    const stats = await this.sync.syncUser(user.id);
    await this.analytics.invalidate(user.id);
    return { ...stats, ...drafts };
  }

  /** Sandbox mode only: simulate an inbound reply / auto-reply / bounce on a sent email. */
  @Post('sandbox/simulate')
  @HttpCode(200)
  async simulate(@CurrentUser() user: AuthUser, @Body(new ZodPipe(simulateSchema)) body: z.infer<typeof simulateSchema>) {
    if (this.accounts.mode !== 'sandbox') throw new DomainError('Simulation is only available in sandbox mode', 400);
    const root = await this.prisma.outreach.findFirst({ where: { id: body.outreachId, userId: user.id, kind: 'INITIAL' }, include: { emailAccount: true, contact: true } });
    if (!root?.gmailThreadId || !root.emailAccount) throw new DomainError('That email has not been sent yet', 400);
    const mailbox = this.accounts.mailbox(root.emailAccount);
    if (body.kind === 'bounce') {
      await this.accounts.sandbox.simulateInbound(mailbox, { threadId: root.gmailThreadId, from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', subject: 'Delivery Status Notification (Failure)', body: 'Address not found' });
    } else if (body.kind === 'auto_reply') {
      await this.accounts.sandbox.simulateInbound(mailbox, { threadId: root.gmailThreadId, from: `${root.contact.name} <${root.toEmail}>`, subject: `Automatic reply: ${root.subject}`, body: 'I am out of the office until Monday.', headers: { 'Auto-Submitted': 'auto-replied' } });
    } else {
      await this.accounts.sandbox.simulateInbound(mailbox, { threadId: root.gmailThreadId, from: `${root.contact.name} <${root.toEmail}>`, subject: `Re: ${root.subject}`, body: body.body });
    }
    const result = await this.sync.syncRootById(root.id);
    await this.analytics.invalidate(user.id);
    return result;
  }

  @Post('sync/queue')
  @HttpCode(202)
  async queue(@CurrentUser() user: AuthUser) {
    await this.queues.syncNow(user.id);
    return { queued: true };
  }
}
