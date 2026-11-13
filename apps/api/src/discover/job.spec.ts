import { AddressInfo } from 'net';
import { createServer } from '../main';
import { createDiscoverJob } from './job';
import type { DiscoverOptions, DiscoverSummary } from './run';

const summary: DiscoverSummary = { picked: 3, qualified: 5, alreadyShown: 1, bySource: { NAUKRI: 3 }, report: '/r.xlsx', seconds: 1 };

describe('createDiscoverJob (one background run at a time)', () => {
  it('runs in the background, collects the log, and reports the result', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const seen: DiscoverOptions[] = [];
    const job = createDiscoverJob(async (o) => {
      seen.push(o);
      o.log?.('✓ LinkedIn: 45 read');
      await gate;
      return summary;
    });
    expect(job.start({ days: 3 })).toBe(true);
    expect(job.status()).toMatchObject({ running: true, log: ['✓ LinkedIn: 45 read'], result: null });
    expect(job.start()).toBe(false); // a second click while running does not start another
    release();
    await job.settled();
    expect(job.status()).toMatchObject({ running: false, result: summary, error: null });
    expect(seen).toHaveLength(1);
    expect(seen[0].days).toBe(3);
  });

  it('reports a failure instead of hiding it, and can run again afterwards', async () => {
    const job = createDiscoverJob(async () => {
      throw new Error('Chrome could not start');
    });
    job.start();
    await job.settled();
    expect(job.status()).toMatchObject({ running: false, error: 'Chrome could not start' });
    expect(job.start()).toBe(true);
  });
});

describe('/api/discover', () => {
  it('POST starts a run (202), a second POST while running is refused (409), GET shows progress', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: DiscoverOptions[] = [];
    const discover = createDiscoverJob(async (o) => (calls.push(o), await gate, summary));
    const server = createServer({ discover }).listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/discover`;
    try {
      expect((await fetch(`${base}?days=3&email=1`, { method: 'POST' })).status).toBe(202);
      expect((await fetch(base, { method: 'POST' })).status).toBe(409);
      expect(await (await fetch(base)).json()).toMatchObject({ running: true });
      release();
      await discover.settled();
      expect(await (await fetch(base)).json()).toMatchObject({ running: false, result: summary });
      expect(calls).toEqual([expect.objectContaining({ days: 3, email: true })]);
    } finally {
      server.close();
    }
  });
});
