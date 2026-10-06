/** Minimal Redis surface the limiter needs (ioredis-compatible; easy to fake in tests). */
export interface RateLimitStore {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  pttl(key: string): Promise<number>;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
  count: number;
}

/**
 * Fixed-window rate limiter backed by Redis INCR + PEXPIRE.
 * Atomic enough for a single-instance personal app; keys expire on their own.
 */
export class RateLimiter {
  constructor(
    private readonly store: RateLimitStore,
    private readonly prefix = 'rl',
  ) {}

  async hit(bucket: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const key = `${this.prefix}:${bucket}`;
    const count = await this.store.incr(key);
    if (count === 1) await this.store.pexpire(key, windowMs);
    let ttl = await this.store.pttl(key);
    if (ttl < 0) {
      // Key lost its TTL (e.g. crash between INCR and PEXPIRE) — repair it.
      await this.store.pexpire(key, windowMs);
      ttl = windowMs;
    }
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetMs: ttl, count };
  }
}
