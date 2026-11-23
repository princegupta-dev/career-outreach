import { z } from 'zod';
import { selectedModel } from './model-settings';

export class OutreachError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export function ollamaConfig(): OllamaConfig {
  const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
  const model = selectedModel() ?? process.env.OLLAMA_MODEL ?? 'qwen3:4b';
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new OutreachError('OLLAMA_BASE_URL must be a local HTTP URL.', 503); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new OutreachError('OLLAMA_BASE_URL must point to localhost. Outreach uses local models only.', 503);
  }
  if (!/^[a-zA-Z0-9._:/-]+$/.test(model) || /cloud/i.test(model)) throw new OutreachError('Choose a local OLLAMA_MODEL, such as qwen3:4b.', 503);
  const timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS ?? 120000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new OutreachError('OLLAMA_TIMEOUT_MS must be between 1000 and 300000.', 503);
  return { baseUrl: url.origin, model, timeoutMs };
}

const tagsSchema = z.object({ models: z.array(z.object({
  name: z.string(), model: z.string().optional(), digest: z.string(),
  remote_model: z.string().nullish(), remote_host: z.string().nullish(),
  size: z.number().optional(),
})) });

async function request(config: OllamaConfig, endpoint: string, init: RequestInit, timeoutMs: number, fetcher: typeof fetch, signal?: AbortSignal): Promise<unknown> {
  try {
    const response = await fetcher(`${config.baseUrl}${endpoint}`, { ...init, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      if (response.status === 404) throw new OutreachError(`Ollama model not found. Run: ollama pull ${config.model}`, 503);
      throw new OutreachError(`Ollama returned HTTP ${response.status}. Check the Ollama app and available memory.`, 503);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof OutreachError) throw error;
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
      throw new OutreachError('Ollama took too long. Try again after the model loads, or choose a smaller model.', 504);
    }
    throw new OutreachError('Could not reach local Ollama. Start the Ollama app or run ollama serve.', 503);
  }
}

export async function listLocalModels(config: OllamaConfig, fetcher: typeof fetch = fetch, signal?: AbortSignal) {
  const tags = tagsSchema.safeParse(await request(config, '/api/tags', {}, 3000, fetcher, signal));
  if (!tags.success) throw new OutreachError('Ollama returned an invalid model list. Update or restart Ollama.');
  return tags.data.models;
}

export async function localModel(config: OllamaConfig, fetcher: typeof fetch = fetch, signal?: AbortSignal) {
  const models = await listLocalModels(config, fetcher, signal);
  const name = config.model.includes(':') ? config.model : `${config.model}:latest`;
  const model = models.find((m) => m.name === name || m.model === name);
  if (!model) throw new OutreachError(`Model is not installed. Run: ollama pull ${config.model}`, 503);
  if (model.remote_model || model.remote_host) throw new OutreachError('This model runs in the cloud. Choose a downloaded local model.', 503);
  return model;
}

export async function ollamaStatus() {
  try {
    const config = ollamaConfig();
    await localModel(config);
    return { ready: true, model: config.model, error: null };
  } catch (error) {
    return { ready: false, model: selectedModel() ?? process.env.OLLAMA_MODEL ?? 'qwen3:4b', error: (error as Error).message };
  }
}

export async function chatJson(config: OllamaConfig, system: string, input: string, schema: Record<string, unknown>, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<unknown> {
  const body = await request(config, '/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.model, stream: false, think: false, format: schema,
      messages: [{ role: 'system', content: system }, { role: 'user', content: input }],
      options: { temperature: 0, num_ctx: 16384, num_predict: 2500 }, keep_alive: '5m',
    }),
  }, config.timeoutMs, fetcher, signal);
  const parsed = z.object({ done: z.literal(true), done_reason: z.string().optional(), message: z.object({ content: z.string() }) }).safeParse(body);
  if (!parsed.success || parsed.data.done_reason === 'length') throw new OutreachError('Ollama did not finish the analysis. Try a smaller job description or a different model.');
  try { return JSON.parse(parsed.data.message.content) as unknown; }
  catch { throw new OutreachError('Ollama returned invalid JSON. Try preparing outreach again.'); }
}
