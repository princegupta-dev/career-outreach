import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service';

export type MetricName =
  | 'ai.call'
  | 'ai.failure'
  | 'ai.cache_hit'
  | 'email.sent'
  | 'email.failure'
  | 'gmail.failure'
  | 'queue.failure'
  | 'job.processed'
  | 'job.processing_failure'
  | 'followup.sent'
  | 'followup.failure'
  | 'followup.cancelled'
  | 'reply.detected';

/**
 * Lightweight metrics: every event is a structured log line (CloudWatch-friendly)
 * plus a daily Redis counter for the health page. No extra infrastructure.
 */
@Injectable()
export class MetricsService {
  private readonly logger = new Logger('Metrics');

  constructor(private readonly redis: RedisService) {}

  async record(name: MetricName, fields: Record<string, unknown> = {}): Promise<void> {
    this.logger.log({ metric: name, ...fields });
    const day = new Date().toISOString().slice(0, 10);
    const key = `metrics:${day}`;
    try {
      await this.redis.client.multi().hincrby(key, name, 1).expire(key, 60 * 60 * 24 * 14).exec();
      if (typeof fields.latencyMs === 'number') {
        await this.redis.client.multi().hincrby(key, `${name}.latency_ms_total`, Math.round(fields.latencyMs)).exec();
      }
    } catch {
      /* metrics must never break the caller */
    }
  }

  async snapshot(days = 7): Promise<Record<string, Record<string, number>>> {
    const out: Record<string, Record<string, number>> = {};
    for (let i = 0; i < days; i++) {
      const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      const h = await this.redis.client.hgetall(`metrics:${day}`);
      out[day] = Object.fromEntries(Object.entries(h).map(([k, v]) => [k, Number(v)]));
    }
    return out;
  }
}
