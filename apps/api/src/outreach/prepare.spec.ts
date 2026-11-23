import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { parseProfileMarkdown } from '../domain/profile/profile';
import type { FoundJob } from '../search';
import { createServer } from '../main';
import { createOutreachService, draftsFor, evidenceFor, validateAnalysis, type PrepareOptions } from './prepare';
import { chatJson, localModel, ollamaConfig, ollamaStatus } from './ollama';

const profile = parseProfileMarkdown(`---
name: Test Candidate
current_company: Private Employer
contact:
  email: private@example.com
compensation:
  india_min_lpa: 42
skills:
  strong: [Node.js, TypeScript, Redis, BullMQ]
  partial: [Kafka]
  learning: [Kubernetes]
---
Private narrative not needed by the model.
`);
const resume = `Test Candidate | private@example.com
- Built background processing with BullMQ and Redis, with retries and idempotent execution.
- Learned Kafka while studying event-driven systems.
- Deployed Kubernetes in a personal lab, not a professional environment.
- Resolved stalled BullMQ jobs and Redis operational issues in production.
`;
const job: FoundJob = {
  id: 'test-job', title: 'Backend Engineer', company: 'Example', companyDomain: null,
  location: 'India', remote: true, url: 'https://example.com/jobs/1', postedAt: null,
  source: 'GREENHOUSE', salaryText: null, teamSize: null, score: 85, recommendation: 'STRONG_APPLY',
  reasons: [], missingSkills: ['Kafka'], flags: [], contacts: [],
  description: 'Build background processing with BullMQ and Redis. Experience with Kafka is required.',
};
const analysis = {
  summary: 'Relevant background processing experience, with a Kafka gap to clarify.',
  matches: [{ requirementQuote: 'background processing with BullMQ and Redis', evidenceId: 'resume-2', explanation: 'A concrete queue processing example.' }],
  gaps: [{ requirementQuote: 'Experience with Kafka is required', explanation: 'Kafka is partial, not strong professional experience.' }],
  questions: ['What is your current depth of Kafka experience?'],
};
const config = { baseUrl: 'http://127.0.0.1:11434', model: 'qwen3:4b', timeoutMs: 1000 };
const tags = { models: [{ name: 'qwen3:4b', digest: 'test-digest' }] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function fakeOllama(value: unknown = analysis) {
  return jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockImplementation(async (input) => String(input).endsWith('/api/tags')
    ? json(tags)
    : json({ done: true, message: { content: JSON.stringify(value) } }));
}

describe('outreach evidence and drafts', () => {
  const evidence = evidenceFor(profile, resume);
  it('includes professional skills and exact resume evidence, excludes partial/learning skills and contact data', () => {
    expect(evidence.find((e) => e.id === 'resume-2')).toEqual({
      id: 'resume-2', source: 'resume', locator: 'resume.txt:2',
      quote: 'Built background processing with BullMQ and Redis, with retries and idempotent execution.',
    });
    expect(evidence.map((e) => e.id)).not.toContain('resume-3');
    expect(evidence.map((e) => e.id)).not.toContain('resume-4');
    expect(JSON.stringify(evidence)).not.toMatch(/private@example.com|Private Employer/);
  });

  it('refuses fabricated evidence IDs, altered requirements, and repeated evidence', () => {
    expect(() => validateAnalysis({ ...analysis, matches: [{ ...analysis.matches[0], evidenceId: 'invented' }] }, job, evidence)).toThrow('unknown experience');
    expect(() => validateAnalysis({ ...analysis, matches: [{ ...analysis.matches[0], requirementQuote: 'Experience with RabbitMQ' }] }, job, evidence)).toThrow('not in the saved job');
    expect(() => validateAnalysis({ ...analysis, matches: [...analysis.matches, ...analysis.matches] }, job, evidence)).toThrow('repeated the same evidence');
    expect(() => validateAnalysis({ summary: 'Incomplete' }, job, evidence)).toThrow('incomplete analysis');
  });

  it('constructs draft claims from source evidence, never from model explanations', () => {
    const checked = validateAnalysis(analysis, job, evidence);
    const drafts = draftsFor(job, profile.name, checked.matches.map((m) => evidence.find((e) => e.id === m.evidenceId)!));
    expect(drafts?.email.body).toContain(evidence.find((e) => e.id === 'resume-2')!.quote);
    expect(drafts?.email.body).not.toContain(analysis.matches[0].explanation);
    expect(drafts?.email.body).not.toMatch(/Kafka|Kubernetes|Private Employer|private@example.com/);
    expect(draftsFor(job, profile.name, [])).toBeNull();
  });
});

describe('Ollama preparation and caching', () => {
  let cacheDir: string;
  let options: PrepareOptions;
  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outreach-test-'));
    options = { config, profile, resume, cacheDir };
  });
  afterEach(() => fs.rmSync(cacheDir, { recursive: true, force: true }));

  it('requests structured local output and reuses validated cache even when Ollama is stopped', async () => {
    const fetcher = fakeOllama();
    const prepare = createOutreachService();
    const first = await prepare(job, { ...options, fetcher });
    expect(first.cached).toBe(false);
    expect(first.matches[0].evidence.locator).toBe('resume.txt:2');
    const request = JSON.parse(fetcher.mock.calls[1][1]!.body as string);
    expect(request).toMatchObject({ model: config.model, stream: false, think: false, format: { type: 'object' }, options: { temperature: 0 } });
    expect(JSON.stringify(request)).not.toMatch(/private@example.com|Private Employer|Private narrative/);
    const offline = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockRejectedValue(new Error('offline'));
    const cached = await createOutreachService()(job, { ...options, fetcher: offline });
    expect(cached).toEqual({ ...first, cached: true });
    expect(offline).not.toHaveBeenCalled();
    expect(fs.statSync(path.join(cacheDir, fs.readdirSync(cacheDir)[0])).mode & 0o777).toBe(0o600);
  });

  it('deduplicates simultaneous requests, rejects different jobs while busy, and clears the busy state', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const fetcher = fakeOllama();
    fetcher.mockImplementation(async (url) => {
      if (String(url).endsWith('/api/tags')) return json(tags);
      await waiting;
      return json({ done: true, message: { content: JSON.stringify(analysis) } });
    });
    const prepare = createOutreachService();
    const first = prepare(job, { ...options, fetcher });
    const duplicate = prepare(job, { ...options, fetcher });
    await expect(prepare({ ...job, id: 'other' }, { ...options, fetcher })).rejects.toMatchObject({ status: 409 });
    release();
    expect(await first).toEqual(await duplicate);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(prepare({ ...job, id: 'other' }, { ...options, fetcher })).resolves.toHaveProperty('cached', false);
  });

  it('invalidates cache when the job, profile, resume, or model changes; recovers from corrupt cache', async () => {
    const fetcher = fakeOllama();
    const prepare = createOutreachService();
    await prepare(job, { ...options, fetcher });
    await prepare({ ...job, description: `${job.description} Additional context.` }, { ...options, fetcher });
    await prepare(job, { ...options, profile: { ...profile, name: 'Updated Name' }, fetcher });
    await prepare(job, { ...options, resume: `${resume}\nAnother line.`, fetcher });
    const other = fakeOllama();
    other.mockImplementationOnce(async () => json({ models: [{ name: 'other:latest', digest: 'other-digest' }] }));
    await prepare(job, { ...options, config: { ...config, model: 'other:latest' }, fetcher: other });
    expect(fs.readdirSync(cacheDir)).toHaveLength(5);
    for (const file of fs.readdirSync(cacheDir)) fs.writeFileSync(path.join(cacheDir, file), '{broken');
    await expect(prepare(job, { ...options, fetcher })).resolves.toHaveProperty('cached', false);
  });

  it('does not cache invalid model output, and never calls Ollama for missing descriptions', async () => {
    const prepare = createOutreachService();
    await expect(prepare(job, { ...options, fetcher: fakeOllama({ ...analysis, matches: [{ ...analysis.matches[0], evidenceId: 'fiction' }] }) })).rejects.toThrow('unknown experience');
    expect(fs.readdirSync(cacheDir)).toHaveLength(0);
    const fetcher = fakeOllama();
    await expect(prepare({ ...job, description: '' }, { ...options, fetcher })).rejects.toMatchObject({ status: 422 });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(prepare(job, { ...options, fetcher })).resolves.toHaveProperty('cached', false);
  });
});

describe('Ollama availability and failures', () => {
  const originalEnv = { ...process.env };
  let settingsDir: string;
  beforeEach(() => {
    settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-config-'));
    process.env.JOB_HUNTER_OLLAMA_SETTINGS = path.join(settingsDir, 'settings.json');
  });
  afterEach(() => { process.env = { ...originalEnv }; fs.rmSync(settingsDir, { recursive: true, force: true }); });

  it('rejects remote hosts and cloud models in configuration', () => {
    for (const url of ['https://ollama.com', 'http://example.com', 'http://127.0.0.1@example.com', 'http://127.0.0.1/api', 'http://127.0.0.1?token=secret']) {
      process.env.OLLAMA_BASE_URL = url;
      expect(() => ollamaConfig()).toThrow();
    }
    process.env.OLLAMA_BASE_URL = config.baseUrl;
    process.env.OLLAMA_MODEL = 'gpt-oss:cloud';
    expect(() => ollamaConfig()).toThrow('local OLLAMA_MODEL');
    process.env.OLLAMA_MODEL = config.model;
    process.env.OLLAMA_TIMEOUT_MS = '0';
    expect(() => ollamaConfig()).toThrow('OLLAMA_TIMEOUT_MS');
  });

  it('rejects cloud-backed installed models and gives an actionable missing-model error', async () => {
    await expect(localModel(config, jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockResolvedValue(json({ models: [] })))).rejects.toThrow('ollama pull qwen3:4b');
    await expect(localModel(config, jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockResolvedValue(json({ models: [{ ...tags.models[0], remote_host: 'https://ollama.com' }] })))).rejects.toThrow('runs in the cloud');
    process.env.OLLAMA_BASE_URL = 'https://example.com';
    expect(await ollamaStatus()).toMatchObject({ ready: false, error: expect.stringContaining('localhost') });
  });

  it('handles offline Ollama, timeout, HTTP errors, invalid JSON, and truncated output', async () => {
    await expect(localModel(config, jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockRejectedValue(new Error('offline')))).rejects.toMatchObject({ status: 503 });
    await expect(localModel(config, jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockRejectedValue(Object.assign(new Error('timeout'), { name: 'TimeoutError' })))).rejects.toMatchObject({ status: 504 });
    await expect(localModel(config, jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockResolvedValue(json({}, 500)))).rejects.toThrow('HTTP 500');
    const run = (value: unknown) => chatJson(config, 'system', 'input', {}, jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockResolvedValue(json(value)));
    await expect(run({ done: true, message: { content: 'not-json' } })).rejects.toThrow('invalid JSON');
    await expect(run({ done: true, done_reason: 'length', message: { content: '{}' } })).rejects.toThrow('did not finish');
    await expect(run({ done: false, message: { content: '{}' } })).rejects.toThrow('did not finish');
  });
});

describe('outreach HTTP flow with a simulated Ollama server', () => {
  it('prepares a saved job, caches the result, and keeps existing routes available when Ollama stops', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outreach-http-'));
    const calls: string[] = [];
    const ollama = http.createServer((req, res) => {
      calls.push(req.url!);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/api/tags' ? tags : { done: true, message: { content: JSON.stringify(analysis) } }));
    });
    await new Promise<void>((resolve) => ollama.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;
    const prepare = createOutreachService();
    const timestamp = '2026-11-17T00:00:00Z';
    const saved = { ...job, firstSeenAt: timestamp, lastSeenAt: timestamp };
    const server = createServer({
      load: () => ({ updatedAt: timestamp, jobs: { [job.id]: saved } }),
      outreach: (j) => prepare(j, { config: { ...config, baseUrl }, profile, resume, cacheDir }),
      ollama: async () => ({ ready: true, model: config.model, error: null }),
      history: () => ({ jobs: {} }),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${api}/api/outreach`, { method: 'POST' })).status).toBe(400);
      expect((await fetch(`${api}/api/outreach?jobId=absent`, { method: 'POST' })).status).toBe(404);
      expect((await fetch(`${api}/api/outreach?jobId=test-job`, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
      const response = await fetch(`${api}/api/outreach?jobId=test-job`, { method: 'POST' });
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toMatchObject({ cached: false, matches: [{ evidence: { source: 'resume', locator: 'resume.txt:2' } }], drafts: { email: { subject: 'Backend Engineer — Test Candidate' } } });
      expect(calls).toEqual(['/api/tags', '/api/chat']);
      await new Promise<void>((resolve) => ollama.close(() => resolve()));
      expect(await (await fetch(`${api}/api/outreach?jobId=test-job`, { method: 'POST' })).json()).toMatchObject({ cached: true });
      expect((await fetch(`${api}/api/health`)).status).toBe(200);
      expect(await (await fetch(`${api}/api/jobs`)).json()).toMatchObject({ jobs: [{ id: job.id, score: 85 }] });
      expect(await (await fetch(`${api}/api/ollama`)).json()).toMatchObject({ ready: true, model: config.model });
      saved.description += ' New requirement means a fresh analysis is needed.';
      const offline = await fetch(`${api}/api/outreach?jobId=test-job`, { method: 'POST' });
      expect(offline.status).toBe(503);
      expect(await offline.json()).toMatchObject({ error: expect.stringContaining('Could not reach local Ollama') });
      expect((await fetch(`${api}/api/health`)).status).toBe(200);
    } finally {
      server.closeAllConnections();
      ollama.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (ollama.listening) await new Promise<void>((resolve) => ollama.close(() => resolve()));
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
