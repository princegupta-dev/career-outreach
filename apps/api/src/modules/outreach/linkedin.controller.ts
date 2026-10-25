import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser, RateLimit, ZodPipe } from '../../common/http';
import { LinkedInService } from './linkedin.service';

const bodySchema = z.object({ contactId: z.string().uuid().optional(), regenerate: z.boolean().optional() });

@Controller()
export class LinkedInController {
  constructor(private readonly linkedin: LinkedInService) {}

  /** Writes a LinkedIn connection note. Nothing is sent anywhere. */
  @Post('jobs/:id/linkedin-note')
  @HttpCode(200)
  @RateLimit({ name: 'ai', limit: 20, windowSec: 60 })
  note(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(bodySchema)) body: z.infer<typeof bodySchema>) {
    return this.linkedin.note(user.id, id, body);
  }
}
