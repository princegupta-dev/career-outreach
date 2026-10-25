import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser, RateLimit, ZodPipe } from '../../common/http';
import { PreparationService } from './preparation.service';

const actionSchema = z.object({ action: z.enum(['shortlist', 'skip', 'restore', 'archive', 'mark_applied']) });

@Controller()
export class PreparationController {
  constructor(private readonly preparation: PreparationService) {}

  /** Progress of "Prepare my application" (persisted — survives a page refresh). */
  @Get('jobs/:id/preparation')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.preparation.get(user.id, id);
  }

  /** Idempotent: a second click returns the run that is already in progress. */
  @Post('jobs/:id/preparation/start')
  @HttpCode(200)
  @RateLimit({ name: 'prepare', limit: 20, windowSec: 60 })
  start(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.preparation.start(user.id, id);
  }

  @Post('jobs/:id/preparation/steps/:step/retry')
  @HttpCode(200)
  @RateLimit({ name: 'prepare', limit: 20, windowSec: 60 })
  retry(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('step') step: string) {
    return this.preparation.retryStep(user.id, id, step);
  }

  /** Continue without a tailored resume (only after that step failed). */
  @Post('jobs/:id/preparation/steps/:step/skip')
  @HttpCode(200)
  skip(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('step') step: string) {
    return this.preparation.skipStep(user.id, id, step);
  }

  @Post('jobs/:id/preparation/steps/:step/confirm')
  @HttpCode(200)
  confirm(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('step') step: string) {
    return this.preparation.confirmStep(user.id, id, step);
  }

  /** The only place preparation can lead to an email being sent — and only because the user asked. */
  @Post('jobs/:id/preparation/approve')
  @HttpCode(200)
  @RateLimit({ name: 'send', limit: 30, windowSec: 60 })
  approve(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.preparation.approve(user.id, id);
  }

  /** Shortlist, skip, restore, archive, or "I applied" (for applications made outside our email flow). */
  @Post('applications/:id/lifecycle')
  @HttpCode(200)
  lifecycle(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(actionSchema)) body: z.infer<typeof actionSchema>) {
    return this.preparation.lifecycle(user.id, id, body.action);
  }
}
