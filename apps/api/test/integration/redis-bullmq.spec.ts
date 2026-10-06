import type { INestApplicationContext } from '@nestjs/common';
import { Job, Queue, Worker } from 'bullmq';
import { RedisService } from '../../src/common/redis.service';
import { QUEUES, QueueService } from '../../src/modules/queues/queues';
import { RetryLaterError } from '../../src/modules/outreach/outreach.service';
import { createContext, flushRedis } from '../setup/helpers';

describe('Redis integration', () => {
  let ctx: INestApplicationContext;
  let redis: RedisService;

  beforeAll(async () => {
    await flushRedis();
    ctx = await createContext();
    redis = ctx.get(RedisService);
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('rate limits per bucket with a fixed window', async () => {
    const results = [];
    for (let i = 0; i < 5; i++) results.push((await redis.limiter.hit('test:ip-1', 3, 2000)).allowed);
    expect(results).toEqual([true, true, true, false, false]);
    expect((await redis.limiter.hit('test:ip-2', 3, 2000)).allowed).toBe(true);
    const ttl = await redis.client.pttl('rl:test:ip-1');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(2000);
  });

  it('provides exclusive locks that only the owner can release', async () => {
    const release = await redis.acquireLock('test-lock', 5000);
    expect(release).toBeTruthy();
    expect(await redis.acquireLock('test-lock', 5000)).toBeNull();
    await release!();
    const again = await redis.acquireLock('test-lock', 5000);
    expect(again).toBeTruthy();
    await again!();
  });

  it('caches JSON with TTL', async () => {
    await redis.setJson('cache:test', { a: 1 }, 10);
    expect(await redis.getJson('cache:test')).toEqual({ a: 1 });
    expect(await redis.client.ttl('cache:test')).toBeGreaterThan(0);
  });
});

describe('BullMQ integration', () => {
  let ctx: INestApplicationContext;
  let queues: QueueService;

  beforeAll(async () => {
    await flushRedis();
    ctx = await createContext();
    queues = ctx.get(QueueService);
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('enqueues one send job per outreach row, no matter how often it is requested', async () => {
    const q = queues.all()[QUEUES.emailSend] as Queue;
    await q.pause();
    await queues.send({ userId: 'u1', outreachId: 'o1' });
    await queues.send({ userId: 'u1', outreachId: 'o1' });
    await queues.send({ userId: 'u1', outreachId: 'o1' }, 60_000);
    const counts = await q.getJobCounts('waiting', 'delayed', 'paused');
    expect(counts.waiting + counts.delayed + counts.paused).toBe(1);
    const job = await q.getJob('send-o1');
    expect(job?.data).toMatchObject({ userId: 'u1', outreachId: 'o1' });
    expect(job?.opts.attempts).toBe(6);
    await queues.cancelSend('o1');
    expect(await q.getJob('send-o1')).toBeUndefined();
    await q.resume();
  });

  it('defers jobs that must run later (RetryLater) without consuming a failed attempt', async () => {
    const connection = { host: new URL(process.env.REDIS_URL!).hostname, port: Number(new URL(process.env.REDIS_URL!).port || 6379), db: 15 };
    const name = `test-defer-${Date.now()}`;
    const q = new Queue(name, { connection, prefix: 'jh' });
    let runs = 0;
    const { DelayedError } = await import('bullmq');
    const worker = new Worker(
      name,
      async (job: Job, token?: string) => {
        runs++;
        if (runs === 1) {
          const err = new RetryLaterError('daily limit', 300);
          await job.moveToDelayed(Date.now() + err.delayMs, token);
          throw new DelayedError();
        }
        return 'sent';
      },
      { connection, prefix: 'jh' },
    );
    const done = new Promise<string>((resolve) => worker.on('completed', (_j, r) => resolve(r as string)));
    await q.add('x', {}, { attempts: 1 });
    await expect(done).resolves.toBe('sent');
    expect(runs).toBe(2);
    await worker.close();
    await q.obliterate({ force: true });
    await q.close();
  });

  it('retries failed jobs with backoff up to the attempt limit', async () => {
    const connection = { host: new URL(process.env.REDIS_URL!).hostname, port: Number(new URL(process.env.REDIS_URL!).port || 6379), db: 15 };
    const name = `test-retry-${Date.now()}`;
    const q = new Queue(name, { connection, prefix: 'jh' });
    let attempts = 0;
    const worker = new Worker(
      name,
      async () => {
        attempts++;
        if (attempts < 3) throw new Error('transient');
        return 'ok';
      },
      { connection, prefix: 'jh' },
    );
    const done = new Promise<void>((resolve) => worker.on('completed', () => resolve()));
    await q.add('x', {}, { attempts: 5, backoff: { type: 'fixed', delay: 50 } });
    await done;
    expect(attempts).toBe(3);
    await worker.close();
    await q.obliterate({ force: true });
    await q.close();
  });
});
