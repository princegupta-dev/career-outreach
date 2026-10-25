import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import IORedis from 'ioredis';
import { AppModule } from '../../src/app.module';
import { CommonModule } from '../../src/common/common.module';
import { PrismaService } from '../../src/common/prisma.service';
import { DomainModule } from '../../src/modules/domain.module';
import { QueuesModule } from '../../src/modules/queues/queues.module';

@Module({ imports: [CommonModule, QueuesModule, DomainModule] })
export class TestDomainModule {}

/** Services-only Nest context (no HTTP). */
export async function createContext() {
  return NestFactory.createApplicationContext(TestDomainModule, { logger: false });
}

/** Full HTTP app, configured like main.ts. */
export async function createHttpApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  await app.init();
  return app;
}

export async function resetDatabase(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE users, profiles, resumes, resume_versions, companies, job_sources, jobs, contacts, applications, outreach, followups, email_accounts, email_events, ai_generations, audit_logs, suppressions CASCADE',
  );
}

export async function flushRedis(): Promise<void> {
  const r = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  await r.flushdb();
  await r.quit();
}

export async function createUser(prisma: PrismaService, settings: Record<string, unknown> = {}) {
  return prisma.user.create({ data: { email: `prince+${Date.now()}@example.com`, passwordHash: 'x', name: 'Prince Gupta', settings: settings as object } });
}

export const BACKEND_JD = `We're hiring a Senior Backend Engineer to build the APIs that power our commerce platform.

Requirements:
- 3+ years of experience building backend systems
- Strong experience with Node.js and TypeScript
- Experience with PostgreSQL and Redis
- Experience with AWS (EC2, RDS, S3)
- Experience designing REST APIs and working with message queues

Nice to have:
- Kafka
- Kubernetes

Fully remote. Compensation: ₹35-45 LPA.
Contact: Sarah Lee (Engineering Manager) - sarah.lee@acmepay.io`;

/** Can this machine start a browser (Playwright Chromium, Chrome or Edge) to build resume PDFs? Tests adapt to the answer. */
export async function pdfBrowserAvailable(): Promise<boolean> {
  const { ChromiumPdfRenderer } = await import('../../src/providers/documents/chromium-pdf');
  const r = new ChromiumPdfRenderer({ pageSize: 'Letter', timeoutMs: 30000 });
  try {
    return await r.available();
  } finally {
    await r.close();
  }
}
