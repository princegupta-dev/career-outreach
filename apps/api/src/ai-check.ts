import { loadEnv } from './config/env';
import { OllamaProvider } from './providers/ai/ollama.provider';

/** `npm run ai:check` — tells you whether the AI setup works, in plain words. Needs no database. */
async function main() {
  const env = loadEnv();
  process.stdout.write(`AI_PROVIDER=${env.AI_PROVIDER}\n`);
  if (env.AI_PROVIDER !== 'ollama') {
    process.stdout.write('Nothing to check: set AI_PROVIDER=ollama in .env to use a local model.\n');
    return;
  }
  const h = await new OllamaProvider({ baseUrl: env.OLLAMA_BASE_URL, model: env.OLLAMA_MODEL, numCtx: env.OLLAMA_NUM_CTX, timeoutMs: env.OLLAMA_TIMEOUT_MS }).health();
  process.stdout.write(`${h.ok ? 'OK' : 'NOT READY'}: ${h.detail}${h.latencyMs ? ` (${h.latencyMs} ms)` : ''}\n`);
  process.exitCode = h.ok ? 0 : 1;
}
void main();
