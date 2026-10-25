import { linkedinNoteSchema } from '../../domain/linkedin/note';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import {
  AIProvider,
  AiResult,
  AnalyzeJobInput,
  EmailDraft,
  emailDraftSchema,
  GenerateEmailRequest,
  GenerateFollowupInput,
  GenerateLinkedInNoteInput,
  JobAnalysis,
  jobAnalysisSchema,
  TailorResumeInput,
  TailoredBullets,
  tailoredBulletsSchema,
} from './ai-provider.interface';
import { analyzeJobPrompt, emailPrompt, followupPrompt, linkedinNotePrompt, profileBlock, SYSTEM_RULES, tailorPrompt } from './prompts';
import type { CandidateProfile } from '../../domain/profile/profile';

export class AiProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface AnthropicProviderOptions {
  apiKey?: string;
  model: string;
  effort: 'low' | 'medium' | 'high';
}

/**
 * Claude-backed provider. Every call uses structured outputs (Zod-validated JSON),
 * a stable cacheable system prompt, and server-side refusal fallbacks.
 */
export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';
  readonly isLlm = true;
  get model(): string {
    return this.opts.model;
  }
  private readonly client: Anthropic;

  constructor(private readonly opts: AnthropicProviderOptions) {
    // Credentials resolve from ANTHROPIC_API_KEY (or an `ant auth login` profile) if not passed.
    this.client = new Anthropic({ ...(opts.apiKey ? { apiKey: opts.apiKey } : {}), maxRetries: 2, timeout: 120_000 });
  }

  private async call<T extends z.ZodType>(profile: CandidateProfile, prompt: string, schema: T, maxTokens: number): Promise<AiResult<z.infer<T>>> {
    try {
      const response = await this.client.beta.messages.parse({
        model: this.opts.model,
        max_tokens: maxTokens,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: this.opts.effort, format: betaZodOutputFormat(schema) },
        system: [
          { type: 'text', text: SYSTEM_RULES },
          { type: 'text', text: profileBlock(profile), cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content: prompt }],
      });
      if (response.stop_reason === 'refusal') throw new AiProviderError('The model declined this request', false);
      if (response.stop_reason === 'max_tokens') throw new AiProviderError('Model output was truncated (max_tokens)', true);
      if (!response.parsed_output) throw new AiProviderError('Model returned output that did not match the schema', true);
      return {
        output: response.parsed_output as z.infer<T>,
        usage: { model: response.model, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      };
    } catch (err) {
      if (err instanceof AiProviderError) throw err;
      if (err instanceof Anthropic.AuthenticationError) throw new AiProviderError('Anthropic authentication failed — check ANTHROPIC_API_KEY', false);
      if (err instanceof Anthropic.BadRequestError) throw new AiProviderError(`Anthropic rejected the request: ${err.message}`, false);
      if (err instanceof Anthropic.RateLimitError) throw new AiProviderError('Anthropic rate limit — retry later', true);
      if (err instanceof Anthropic.APIError) throw new AiProviderError(`Anthropic API error ${err.status ?? ''}`.trim(), true);
      throw new AiProviderError(`Anthropic call failed: ${(err as Error).message}`, true);
    }
  }

  analyzeJob(input: AnalyzeJobInput): Promise<AiResult<JobAnalysis>> {
    return this.call(input.profile, analyzeJobPrompt(input), jobAnalysisSchema, 8000);
  }

  tailorResume(input: TailorResumeInput): Promise<AiResult<TailoredBullets>> {
    return this.call(input.profile, tailorPrompt(input), tailoredBulletsSchema, 6000);
  }

  async generateEmail(req: GenerateEmailRequest): Promise<AiResult<EmailDraft>> {
    const r = await this.call(req.profile, emailPrompt(req.input, req.previousProblems), emailDraftSchema, 4000);
    return { ...r, output: { ...r.output, provider: this.name } };
  }

  async generateFollowup(input: GenerateFollowupInput): Promise<AiResult<EmailDraft>> {
    const r = await this.call(input.profile, followupPrompt(input), emailDraftSchema, 3000);
    return { ...r, output: { ...r.output, provider: this.name } };
  }

  generateLinkedInNote(req: GenerateLinkedInNoteInput): Promise<AiResult<{ note: string }>> {
    return this.call(req.profile, linkedinNotePrompt(req.input, req.previousProblems), linkedinNoteSchema, 600);
  }
}
