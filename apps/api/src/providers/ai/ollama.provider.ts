import { z } from 'zod';
import type { CandidateProfile } from '../../domain/profile/profile';
import {
  AIProvider,
  AiHealth,
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
import { linkedinNoteSchema } from '../../domain/linkedin/note';
import { AiProviderError } from './anthropic.provider';
import { analyzeJobPrompt, emailPrompt, followupPrompt, linkedinNotePrompt, profileBlock, SYSTEM_RULES, tailorPrompt } from './prompts';

export interface OllamaProviderOptions {
  baseUrl: string;
  model: string;
  /** Context window to allocate. Bigger needs more RAM; job descriptions + profile fit in 8192. */
  numCtx: number;
  timeoutMs: number;
}

interface ChatResponse {
  model?: string;
  message?: { content?: string };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/** Models can wrap JSON in a code fence even when told not to. */
const unfence = (s: string) => s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

/**
 * A local model served by Ollama (https://ollama.com): free, private, no API key.
 * Uses Ollama's structured outputs (`format` = JSON schema), so the model is constrained to the exact shape the app
 * needs, and the result is validated again with the same Zod schemas as every other provider. Whatever the model
 * writes still passes through the truth guard and the email checks before it is used.
 */
export class OllamaProvider implements AIProvider {
  readonly name = 'ollama';
  readonly isLlm = true;

  constructor(private readonly opts: OllamaProviderOptions) {}

  get model(): string {
    return this.opts.model;
  }

  private url(path: string): string {
    return `${this.opts.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  private unreachable(): AiProviderError {
    return new AiProviderError(`Could not reach Ollama at ${this.opts.baseUrl}. Is it running? Open the Ollama app, or run "ollama serve".`, true);
  }

  private async post(path: string, body: unknown): Promise<Response> {
    try {
      return await fetch(this.url(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.opts.timeoutMs) });
    } catch (e) {
      if ((e as Error).name === 'TimeoutError') throw new AiProviderError(`Ollama took longer than ${Math.round(this.opts.timeoutMs / 1000)}s to answer. A smaller model (or a shorter job description) is faster.`, true);
      throw this.unreachable();
    }
  }

  private async call<T extends z.ZodType>(profile: CandidateProfile, prompt: string, schema: T, maxTokens: number): Promise<AiResult<z.infer<T>>> {
    const res = await this.post('/api/chat', {
      model: this.opts.model,
      stream: false,
      format: z.toJSONSchema(schema),
      options: { temperature: 0.2, repeat_penalty: 1.15, num_ctx: this.opts.numCtx, num_predict: maxTokens },
      messages: [
        { role: 'system', content: `${SYSTEM_RULES}\n\n${profileBlock(profile)}` },
        { role: 'user', content: `${prompt}\n\nAnswer with the JSON object only.` },
      ],
    });
    const raw = await res.text();
    let json: ChatResponse = {};
    try {
      json = JSON.parse(raw) as ChatResponse;
    } catch {
      /* not JSON: handled below */
    }
    if (!res.ok) {
      const msg = json.error ?? raw.slice(0, 200);
      // Fixable in a minute (and not an outage): never pauses the AI for 30 minutes.
      if (res.status === 404 || /not found/i.test(msg)) throw new AiProviderError(`The Ollama model "${this.opts.model}" is not installed yet. Run: ollama pull ${this.opts.model}`, true);
      throw new AiProviderError(`Ollama error ${res.status}: ${msg}`, res.status >= 500);
    }
    if (json.done_reason === 'length') throw new AiProviderError('The local model ran out of space before finishing its answer.', true);
    const content = json.message?.content;
    if (!content) throw new AiProviderError('The local model returned an empty answer.', true);
    let parsed: z.infer<T>;
    try {
      const r = schema.safeParse(JSON.parse(unfence(content)));
      if (!r.success) throw new Error(r.error.issues[0] ? `${r.error.issues[0].path.join('.') || 'answer'}: ${r.error.issues[0].message}` : 'schema mismatch');
      parsed = r.data as z.infer<T>;
    } catch (e) {
      throw new AiProviderError(`The local model's answer did not match the expected format (${(e as Error).message.slice(0, 120)}).`, true);
    }
    return { output: parsed, usage: { model: json.model ?? this.opts.model, inputTokens: json.prompt_eval_count ?? 0, outputTokens: json.eval_count ?? 0 } };
  }

  analyzeJob(input: AnalyzeJobInput): Promise<AiResult<JobAnalysis>> {
    return this.call(input.profile, analyzeJobPrompt(input), jobAnalysisSchema, 1500);
  }

  tailorResume(input: TailorResumeInput): Promise<AiResult<TailoredBullets>> {
    return this.call(input.profile, tailorPrompt(input), tailoredBulletsSchema, 1400);
  }

  async generateEmail(req: GenerateEmailRequest): Promise<AiResult<EmailDraft>> {
    const r = await this.call(req.profile, emailPrompt(req.input, req.previousProblems), emailDraftSchema, 1200);
    return { ...r, output: { ...r.output, provider: this.name } };
  }

  async generateFollowup(input: GenerateFollowupInput): Promise<AiResult<EmailDraft>> {
    const r = await this.call(input.profile, followupPrompt(input), emailDraftSchema, 900);
    return { ...r, output: { ...r.output, provider: this.name } };
  }

  generateLinkedInNote(req: GenerateLinkedInNoteInput): Promise<AiResult<{ note: string }>> {
    return this.call(req.profile, linkedinNotePrompt(req.input, req.previousProblems), linkedinNoteSchema, 300);
  }

  /** Is the server up, is the model installed, and can it produce structured output? Says what to do if not. */
  async health(): Promise<AiHealth> {
    const base = { provider: this.name, model: this.opts.model };
    let installed: string[];
    try {
      const res = await fetch(this.url('/api/tags'), { signal: AbortSignal.timeout(5000) });
      installed = ((await res.json()) as { models?: Array<{ name?: string; model?: string }> }).models?.map((m) => m.name ?? m.model ?? '') ?? [];
    } catch {
      return { ...base, ok: false, detail: this.unreachable().message };
    }
    const want = this.opts.model;
    const has = installed.some((n) => n === want || n === `${want}:latest` || (!want.includes(':') && n.split(':')[0] === want));
    if (!has) return { ...base, ok: false, detail: `Ollama is running, but the model "${want}" is not installed. Run: ollama pull ${want}${installed.length ? ` (installed: ${installed.slice(0, 5).join(', ')})` : ''}` };
    const started = Date.now();
    try {
      const res = await this.post('/api/chat', { model: want, stream: false, format: z.toJSONSchema(z.object({ ok: z.boolean() })), options: { temperature: 0, num_predict: 30, num_ctx: 1024 }, messages: [{ role: 'user', content: 'Reply with {"ok": true}' }] });
      if (!res.ok) return { ...base, ok: false, detail: `Ollama answered with an error (${res.status}): ${(await res.text()).slice(0, 160)}` };
      const out = z.object({ ok: z.boolean() }).safeParse(JSON.parse(unfence(((await res.json()) as ChatResponse).message?.content ?? '')));
      if (!out.success) return { ...base, ok: false, detail: `The model "${want}" is installed but did not answer in the required JSON format. Try a larger or newer model.` };
    } catch (e) {
      return { ...base, ok: false, detail: e instanceof AiProviderError ? e.message : `The test call failed: ${(e as Error).message.slice(0, 120)}` };
    }
    return { ...base, ok: true, latencyMs: Date.now() - started, detail: `Ollama is ready: "${want}" answered in the required format.` };
  }
}
