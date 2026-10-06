import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { loadEnv } from '../../config/env';
import { DEFAULT_JOB_OPTIONS, QUEUES, QueueService } from './queues';

function redisConnection() {
  const url = new URL(loadEnv().REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname && url.pathname !== '/' ? Number(url.pathname.slice(1)) : 0,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

@Global()
@Module({
  imports: [
    BullModule.forRoot({ connection: redisConnection(), prefix: 'jh', defaultJobOptions: DEFAULT_JOB_OPTIONS }),
    BullModule.registerQueue(...Object.values(QUEUES).map((name) => ({ name }))),
  ],
  providers: [QueueService],
  exports: [QueueService, BullModule],
})
export class QueuesModule {}
