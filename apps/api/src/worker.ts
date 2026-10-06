import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { loadEnv } from './config/env';
import { QUEUES, QueueService } from './modules/queues/queues';
import { PrismaService } from './common/prisma.service';
import { DiscoveryService } from './modules/discovery/discovery.service';
import { WorkerModule } from './worker.module';

/** Repeatable schedules (idempotent upserts — safe to run on every start). */
async function registerSchedules(queues: QueueService): Promise<void> {
  const env = loadEnv();
  const q = queues.all();
  const all = { userId: '*' };
  await q[QUEUES.emailSync].upsertJobScheduler('email-sync', { pattern: env.EMAIL_SYNC_CRON }, { name: 'sync', data: all });
  await q[QUEUES.followups].upsertJobScheduler('followup-tick', { pattern: env.FOLLOWUP_CRON }, { name: 'tick', data: all });
  await q[QUEUES.discovery].upsertJobScheduler('discovery', { pattern: env.DISCOVERY_CRON }, { name: 'discover', data: all });
  await q[QUEUES.analytics].upsertJobScheduler('analytics', { pattern: env.ANALYTICS_CRON }, { name: 'refresh', data: all });
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  await registerSchedules(app.get(QueueService));
  // First start / long downtime: find today's jobs right away instead of waiting for the schedule.
  const users = await app.get(PrismaService).user.findMany({ select: { id: true } });
  for (const u of users) {
    if (await app.get(DiscoveryService).isStale(u.id)) await app.get(QueueService).discover({ userId: u.id, trigger: 'startup' });
  }
  app.get(Logger).log('Worker started: job discovery, processing, resume, email generation/sending, sync, follow-ups, analytics');
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
