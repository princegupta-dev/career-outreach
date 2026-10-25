import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AiKind, Prisma } from '@prisma/client';
import { hashObject } from '../../common/crypto';
import { MetricsService } from '../../common/metrics.service';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import { ENV, Env } from '../../config/env';
import { AIProvider, AiHealth, AiResult } from '../../providers/ai/ai-provider.interface';
import { AiProviderError, AnthropicProvider } from '../../providers/ai/anthropic.provider';
import { OllamaProvider } from '../../providers/ai/ollama.provider';
import { TemplateProvider } from '../../providers/ai/template.provider';

const CIRCUIT_KEY = 'ai:circuit';
const CIRCUIT_MS = 30 * 60_000;
/** Errors that will not fix themselves on retry (no credit, bad key, model access). */
const FATAL = /credit balance|billing|authentication|invalid x-api-key|permission|not_found_error|model/i;

export interface AiRunResult<T> {
  output: T;
  provider: string;
  cached: boolean;
  /** True when the LLM failed and the deterministic template was used instead. */
  fallback: boolean;
  generationId?: string;
}

/**
 * Single entry point for every AI call:
 * - content-hash cache in ai_generations (same input ⇒ no new LLM call)
 * - per-input lock so concurrent workers don't double-spend
 * - latency / token / failure metrics
 * - automatic fallback to the zero-cost template provider
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  readonly primary: AIProvider;
  readonly template = new TemplateProvider();

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
  ) {
    this.primary =
      env.AI_PROVIDER === 'anthropic'
        ? new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY || undefined, model: env.ANTHROPIC_MODEL, effort: env.ANTHROPIC_EFFORT })
        : env.AI_PROVIDER === 'ollama'
          ? new OllamaProvider({ baseUrl: env.OLLAMA_BASE_URL, model: env.OLLAMA_MODEL, numCtx: env.OLLAMA_NUM_CTX, timeoutMs: env.OLLAMA_TIMEOUT_MS })
          : this.template;
  }

  get usesLlm(): boolean {
    return this.primary.isLlm;
  }

  status(): { provider: string; model: string | null; llm: boolean } {
    return { provider: this.primary.name, model: this.primary.model, llm: this.primary.isLlm };
  }

  /** Is the configured provider usable right now? Never throws. */
  async check(): Promise<AiHealth> {
    if (this.primary.health) return this.primary.health();
    return { ok: true, provider: this.primary.name, model: this.primary.model, detail: this.primary.isLlm ? 'Provider configured.' : 'Using the built-in template writer (no AI model).' };
  }

  /** Why LLM calls are paused (billing/auth errors), if they are. */
  async circuit(): Promise<{ open: boolean; reason: string | null; until: string | null }> {
    const v = await this.redis.getJson<{ reason: string; until: string }>(CIRCUIT_KEY);
    return v ? { open: true, ...v } : { open: false, reason: null, until: null };
  }

  private async openCircuit(reason: string): Promise<void> {
    const until = new Date(Date.now() + CIRCUIT_MS).toISOString();
    await this.redis.setJson(CIRCUIT_KEY, { reason, until }, CIRCUIT_MS / 1000);
    this.logger.warn({ msg: 'LLM calls paused', reason, until });
  }

  async run<T>(
    userId: string,
    kind: AiKind,
    cacheInput: unknown,
    call: (p: AIProvider) => Promise<AiResult<T>>,
    opts: { force?: boolean; allowFallback?: boolean } = {},
  ): Promise<AiRunResult<T>> {
    const provider = this.primary;
    const inputHash = hashObject({ kind, provider: provider.name, model: provider.model ?? 'template', input: cacheInput });

    if (!opts.force) {
      const cached = await this.prisma.aiGeneration.findFirst({
        where: { userId, kind, inputHash, status: 'SUCCESS' },
        orderBy: { createdAt: 'desc' },
      });
      if (cached?.output) {
        await this.metrics.record('ai.cache_hit', { kind });
        return { output: cached.output as T, provider: cached.provider, cached: true, fallback: false, generationId: cached.id };
      }
    }

    // Circuit open (e.g. no API credit): don't hammer the API, use the deterministic provider.
    if (provider.isLlm && opts.allowFallback !== false && (await this.circuit()).open) {
      const fb = await call(this.template);
      return { output: fb.output, provider: this.template.name, cached: false, fallback: true };
    }

    const release = await this.redis.acquireLock(`ai:${inputHash}`, 180_000);
    try {
      if (!release && !opts.force) {
        // Another worker is generating the same thing — wait briefly for its result.
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const done = await this.prisma.aiGeneration.findFirst({ where: { userId, kind, inputHash, status: 'SUCCESS' } });
          if (done?.output) return { output: done.output as T, provider: done.provider, cached: true, fallback: false, generationId: done.id };
        }
      }
      const started = Date.now();
      try {
        const result = await call(provider);
        const latencyMs = Date.now() - started;
        const row = await this.prisma.aiGeneration.create({
          data: {
            userId,
            kind,
            inputHash,
            provider: provider.name,
            model: result.usage.model,
            status: 'SUCCESS',
            output: result.output as unknown as Prisma.InputJsonValue,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            latencyMs,
          },
        });
        if (provider.isLlm) await this.metrics.record('ai.call', { kind, latencyMs, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens });
        return { output: result.output, provider: provider.name, cached: false, fallback: false, generationId: row.id };
      } catch (err) {
        const latencyMs = Date.now() - started;
        const message = err instanceof AiProviderError ? err.message : `AI call failed: ${(err as Error).message}`;
        await this.prisma.aiGeneration.create({
          data: { userId, kind, inputHash, provider: provider.name, model: provider.model ?? 'template', status: 'FAILED', error: message.slice(0, 500), latencyMs },
        });
        await this.metrics.record('ai.failure', { kind, latencyMs, error: message });
        if (provider.isLlm && err instanceof AiProviderError && !err.retryable && FATAL.test(message)) await this.openCircuit(message.slice(0, 300));
        if (provider.isLlm && opts.allowFallback !== false) {
          this.logger.warn({ msg: 'LLM failed — using deterministic fallback', kind, error: message });
          const fb = await call(this.template);
          return { output: fb.output, provider: this.template.name, cached: false, fallback: true };
        }
        throw err;
      }
    } finally {
      await release?.();
    }
  }
}
