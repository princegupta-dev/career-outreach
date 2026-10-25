import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OllamaProvider } from './ollama.provider';
import { AiProviderError } from './anthropic.provider';
import { loadProfile } from '../../domain/__fixtures__/fixtures';

interface ReqBody {
  format: { type: string };
  messages: Array<{ role: string }>;
  [k: string]: unknown;
}
type Handler = (path: string, body: ReqBody) => { status?: number; json: unknown } | 'hang';

describe('OllamaProvider (against a fake Ollama server)', () => {
  let server: Server;
  let base = '';
  let handler: Handler;
  const requests: Array<{ path: string; body: ReqBody }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : ({} as ReqBody);
        requests.push({ path: req.url ?? '', body });
        const r = handler(req.url ?? '', body);
        if (r === 'hang') return;
        res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.json));
      });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((ok) => server.close(ok)));
  beforeEach(() => {
    requests.length = 0;
  });

  const provider = (o: Partial<{ baseUrl: string; model: string; timeoutMs: number }> = {}) => new OllamaProvider({ baseUrl: base, model: 'qwen2.5:3b', numCtx: 4096, timeoutMs: 3000, ...o });
  const profile = loadProfile();
  const tailorInput = { profile, jobTitle: 'Backend Engineer', companyName: 'Acme', jobSkills: ['node'], description: 'Build APIs', bullets: [{ id: 'b1', text: 'Built APIs', roleTechnologies: ['node'] }] };

  it('sends a JSON-schema constrained chat request and parses the answer', async () => {
    handler = () => ({ json: { model: 'qwen2.5:3b', message: { content: '```json\n{"bullets":[]}\n```' }, done_reason: 'stop', prompt_eval_count: 11, eval_count: 5 } });
    const r = await provider().tailorResume(tailorInput).catch((e: Error) => e);
    // Whatever the schema's exact shape, the request must be well formed.
    const req = requests[0];
    expect(req.path).toBe('/api/chat');
    expect(req.body).toMatchObject({ model: 'qwen2.5:3b', stream: false, options: { num_ctx: 4096 } });
    expect(req.body.format.type).toBe('object');
    expect(req.body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
    if (!(r instanceof Error)) expect(r.usage).toEqual({ model: 'qwen2.5:3b', inputTokens: 11, outputTokens: 5 });
  });

  it('turns "model not installed" into a fixable, retryable error (so the 30-minute circuit does not open)', async () => {
    handler = () => ({ status: 404, json: { error: "model 'qwen2.5:3b' not found" } });
    const e = await provider().tailorResume(tailorInput).catch((x) => x);
    expect(e).toBeInstanceOf(AiProviderError);
    expect(e.retryable).toBe(true);
    expect(e.message).toContain('ollama pull qwen2.5:3b');
  });

  it('rejects answers that do not match the schema, retryably', async () => {
    handler = () => ({ json: { message: { content: '{"nope":1}' }, done_reason: 'stop' } });
    const e = await provider().tailorResume(tailorInput).catch((x) => x);
    expect(e).toBeInstanceOf(AiProviderError);
    expect(e.retryable).toBe(true);
  });

  it('reports a truncated answer', async () => {
    handler = () => ({ json: { message: { content: '{"bul' }, done_reason: 'length' } });
    const e = await provider().tailorResume(tailorInput).catch((x) => x);
    expect(e.message).toMatch(/ran out of space/);
  });

  it('says how to start Ollama when it is unreachable', async () => {
    const e = await provider({ baseUrl: 'http://127.0.0.1:1' }).tailorResume(tailorInput).catch((x) => x);
    expect(e.retryable).toBe(true);
    expect(e.message).toContain('ollama serve');
  });

  it('times out instead of hanging', async () => {
    handler = () => 'hang';
    const e = await provider({ timeoutMs: 300 }).tailorResume(tailorInput).catch((x) => x);
    expect(e.message).toMatch(/longer than/);
  });

  describe('health()', () => {
    it('is ok when the model is installed and answers in JSON', async () => {
      handler = (path) => (path === '/api/tags' ? { json: { models: [{ name: 'qwen2.5:3b' }] } } : { json: { message: { content: '{"ok":true}' } } });
      const h = await provider().health();
      expect(h.ok).toBe(true);
      expect(h.latencyMs).toBeGreaterThanOrEqual(0);
    });
    it('tells you to pull a missing model', async () => {
      handler = () => ({ json: { models: [{ name: 'llama3.2:1b' }] } });
      const h = await provider().health();
      expect(h.ok).toBe(false);
      expect(h.detail).toContain('ollama pull qwen2.5:3b');
    });
    it('tells you to start Ollama when it is down', async () => {
      const h = await provider({ baseUrl: 'http://127.0.0.1:1' }).health();
      expect(h.ok).toBe(false);
      expect(h.detail).toContain('ollama serve');
    });
  });
});
