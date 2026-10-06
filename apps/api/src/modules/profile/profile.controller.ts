import { Body, Controller, Get, Patch, Put } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser, ZodPipe } from '../../common/http';
import { AiService } from '../ai/ai.service';
import { JobsService } from '../jobs/jobs.service';
import { SettingsService } from '../settings/settings.service';
import { ProfileService } from './profile.service';

const profileUpdate = z.object({ markdown: z.string().min(20).max(100_000) });
/** Partial patch; the merged result is fully validated by SettingsService. */
const settingsPatch = z.record(z.string(), z.unknown());

@Controller()
export class ProfileController {
  constructor(
    private readonly profiles: ProfileService,
    private readonly settings: SettingsService,
    private readonly jobs: JobsService,
    private readonly ai: AiService,
  ) {}

  @Get('profile')
  async get() {
    const [markdown, profile] = await Promise.all([this.profiles.readMarkdown(), this.profiles.get()]);
    const missing: string[] = [];
    if (!profile.current_company) missing.push('current_company');
    if (!profile.contact.email) missing.push('contact.email');
    if (!profile.education.some((e) => e.institution)) missing.push('education.institution');
    return { markdown, profile, missing, path: this.profiles.filePath };
  }

  /** Saves the canonical profile file and re-scores jobs (deterministic, no LLM). */
  @Put('profile')
  async update(@CurrentUser() user: AuthUser, @Body(new ZodPipe(profileUpdate)) body: z.infer<typeof profileUpdate>) {
    const profile = await this.profiles.update(user.id, body.markdown);
    const { rescored } = await this.jobs.rescoreAll(user.id);
    return { profile, rescored };
  }

  @Get('settings')
  async getSettings(@CurrentUser() user: AuthUser) {
    return { settings: await this.settings.get(user.id), ai: { ...this.ai.status(), circuit: await this.ai.circuit() } };
  }

  @Patch('settings')
  async patchSettings(@CurrentUser() user: AuthUser, @Body(new ZodPipe(settingsPatch)) body: Record<string, unknown>) {
    const settings = await this.settings.update(user.id, body);
    await this.jobs.rescoreAll(user.id);
    return { settings };
  }
}
