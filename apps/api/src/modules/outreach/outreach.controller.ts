import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser, DomainError, RateLimit, ZodPipe } from '../../common/http';
import { PrismaService } from '../../common/prisma.service';
import { EmailAccountsService } from '../email/email-accounts.service';
import { FollowupsService } from '../followups/followups.service';
import { ProfileService } from '../profile/profile.service';
import { OutreachService } from './outreach.service';

const generateSchema = z.object({
  contactId: z.string().uuid().optional(),
  style: z.enum(['concise', 'technical', 'warm']).optional(),
  attachResume: z.boolean().optional(),
  regenerate: z.boolean().optional(),
});

const draftSchema = z.object({
  subject: z.string().trim().min(1).max(200).optional(),
  body: z.string().trim().min(10).max(5000).optional(),
  toEmail: z.string().trim().email().max(254).optional(),
  attachResume: z.boolean().optional(),
});

@Controller()
export class OutreachController {
  constructor(
    private readonly outreach: OutreachService,
    private readonly followups: FollowupsService,
    private readonly accounts: EmailAccountsService,
    private readonly profiles: ProfileService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('outreach')
  list(@CurrentUser() user: AuthUser, @Query(new ZodPipe(z.object({ status: z.string().max(20).optional(), kind: z.enum(['INITIAL', 'FOLLOWUP']).optional() }))) q: { status?: string; kind?: string }) {
    return this.outreach.list(user.id, q);
  }

  @Get('outreach/:id')
  preview(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.outreach.preview(user.id, id);
  }

  @Post('applications/:id/email')
  @RateLimit({ name: 'ai', limit: 20, windowSec: 60 })
  generate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(generateSchema)) body: z.infer<typeof generateSchema>) {
    return this.outreach.generateInitial(user.id, id, body);
  }

  @Patch('outreach/:id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(draftSchema)) body: z.infer<typeof draftSchema>) {
    return this.outreach.updateDraft(user.id, id, body);
  }

  /** Explicit approval → queued send. Nothing is ever sent without this call. */
  @Post('outreach/:id/approve')
  @HttpCode(200)
  @RateLimit({ name: 'send', limit: 30, windowSec: 60 })
  approve(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ overrideCompanyCooldown: z.boolean().optional() }))) body: { overrideCompanyCooldown?: boolean }) {
    return this.outreach.approve(user.id, id, body);
  }

  @Post('outreach/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.outreach.cancel(user.id, id);
  }

  /** Optional: put the draft into Gmail's Drafts folder to review there. */
  @Post('outreach/:id/gmail-draft')
  @HttpCode(200)
  async gmailDraft(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const o = await this.outreach.getOwned(user.id, id);
    if (o.status !== 'DRAFT' && o.status !== 'APPROVED') throw new DomainError('Only drafts can be copied to Gmail', 409);
    const account = await this.accounts.sendingAccount(user.id);
    const profile = await this.profiles.get();
    const r = await this.accounts.providerFor(account).createDraft(this.accounts.mailbox(account), {
      fromName: profile.name,
      to: o.toEmail,
      subject: o.subject,
      text: o.body,
      messageIdHeader: o.messageIdHeader.replace('@', '-draft@'),
    });
    await this.prisma.emailEvent.create({ data: { userId: user.id, outreachId: o.id, emailAccountId: account.id, type: 'DRAFT_CREATED', metadata: { draftId: r.draftId } } });
    return r;
  }

  /** Retry mirroring this email into Gmail Drafts. */
  @Post('outreach/:id/sync-draft')
  @HttpCode(200)
  async syncDraft(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.outreach.getOwned(user.id, id);
    await this.outreach.syncDraft(id);
    return this.outreach.getOwned(user.id, id);
  }

  // ─── Follow-ups ────────────────────────────────────────────────────────────

  @Get('followups')
  pending(@CurrentUser() user: AuthUser) {
    return this.followups.listPending(user.id);
  }

  @Post('followups/:id/prepare')
  @HttpCode(200)
  async prepare(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ regenerate: z.boolean().optional() }))) body: { regenerate?: boolean }) {
    await this.followups.get(user.id, id);
    return this.outreach.generateFollowupDraft(id, body);
  }

  @Post('followups/:id/skip')
  @HttpCode(200)
  async skip(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.followups.skip(user.id, id);
    return { ok: true };
  }

  @Post('outreach/:id/followups/cancel')
  @HttpCode(200)
  cancelFollowups(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.followups.cancelAll(user.id, id);
  }

  // ─── Suppression list ──────────────────────────────────────────────────────

  @Get('suppressions')
  suppressions(@CurrentUser() user: AuthUser) {
    return this.prisma.suppression.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
  }

  @Post('suppressions')
  addSuppression(@CurrentUser() user: AuthUser, @Body(new ZodPipe(z.object({ value: z.string().trim().min(3).max(254), reason: z.string().max(200).default('Manual') }))) body: { value: string; reason: string }) {
    const value = body.value.toLowerCase();
    return this.prisma.suppression.upsert({
      where: { userId_value: { userId: user.id, value } },
      create: { userId: user.id, value, kind: value.includes('@') && !value.startsWith('@') ? 'email' : 'domain', reason: body.reason },
      update: { reason: body.reason },
    });
  }

  @Post('suppressions/:id/delete')
  @HttpCode(200)
  async deleteSuppression(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.prisma.suppression.deleteMany({ where: { id, userId: user.id } });
    return { ok: true };
  }
}
