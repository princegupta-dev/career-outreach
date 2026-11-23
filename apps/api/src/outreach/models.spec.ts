import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createModelManager } from './models';
import { ollamaConfig } from './ollama';

describe('model management from the dashboard', () => {
  let dir: string;
  const original = { ...process.env };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-ui-'));
    process.env.JOB_HUNTER_OLLAMA_SETTINGS = path.join(dir, 'ollama.json');
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
    process.env.OLLAMA_MODEL = 'qwen3:4b';
  });
  afterEach(() => { process.env = { ...original }; fs.rmSync(dir, { recursive: true, force: true }); });
  const tags = { models: [{ name: 'qwen3:4b', size: 2500000000, digest: 'test' }, { name: 'remote:latest', digest: 'remote', remote_host: 'https://ollama.com' }] };
  const fetcher = () => jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockImplementation(async () => new Response(JSON.stringify(tags)));

  it('lists only local models and persists a selected installed model', async () => {
    const manager = createModelManager(fetcher());
    expect((await manager.list()).models).toEqual([{ name: 'qwen3:4b', size: 2500000000 }]);
    await manager.select('qwen3:4b');
    expect(ollamaConfig().model).toBe('qwen3:4b');
    await expect(manager.select('remote:latest')).rejects.toThrow('runs in the cloud');
    await expect(manager.select('missing:latest')).rejects.toThrow('not installed');
  });
  it('reads streamed download progress and selects the model only after successful completion', async () => {
    const mock = fetcher();
    mock.mockImplementation(async (url) => String(url).endsWith('/api/pull')
      ? new Response('{"status":"pulling","total":100,"completed":50}\n{"status":"success"}\n')
      : new Response(JSON.stringify(tags)));
    const manager = createModelManager(mock);
    expect(manager.pull('qwen3:4b').running).toBe(true);
    expect(() => manager.pull('qwen3:4b')).toThrow('already running');
    await manager.settled();
    expect(manager.status()).toMatchObject({ running: false, percent: 100, error: null });
    expect(fs.existsSync(process.env.JOB_HUNTER_OLLAMA_SETTINGS!)).toBe(true);
  });
  it('reports failed or incomplete downloads without selecting them', async () => {
    const mock = fetcher();
    mock.mockResolvedValue(new Response('{"error":"not enough space"}\n'));
    const manager = createModelManager(mock);
    manager.pull('qwen3:4b'); await manager.settled();
    expect(manager.status()).toMatchObject({ running: false, error: 'not enough space' });
    expect(fs.existsSync(process.env.JOB_HUNTER_OLLAMA_SETTINGS!)).toBe(false);
    expect(() => manager.pull('model:cloud')).toThrow('local model name');
  });
});
