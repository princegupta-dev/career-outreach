import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import IORedis, { Redis } from 'ioredis';
import { ENV, Env } from '../config/env';
import { RateLimiter } from './rate-limiter';

/** Shared Redis connection (cache, locks, rate limits). BullMQ opens its own connections. */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;
  readonly limiter: RateLimiter;

  constructor(@Inject(ENV) env: Env) {
    this.client = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
    this.limiter = new RateLimiter(this.client);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const v = await this.client.get(key);
    return v ? (JSON.parse(v) as T) : null;
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  /**
   * Best-effort distributed lock (SET NX PX). Returns a release function, or null if held.
   * PostgreSQL state transitions remain the real guard; this just avoids wasted work.
   */
  async acquireLock(name: string, ttlMs: number): Promise<(() => Promise<void>) | null> {
    const token = `${process.pid}:${Date.now()}:${Math.random()}`;
    const ok = await this.client.set(`lock:${name}`, token, 'PX', ttlMs, 'NX');
    if (ok !== 'OK') return null;
    return async () => {
      // Release only if we still own it.
      await this.client.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, `lock:${name}`, token);
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }
}
