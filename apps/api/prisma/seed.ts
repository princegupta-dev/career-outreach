/**
 * Seed script.
 *   SEED_USER_EMAIL / SEED_USER_PASSWORD / SEED_USER_NAME → create the app login (optional;
 *     otherwise register on first visit to the web app).
 *   SEED_DEMO=true → add demo jobs + a demo contact (marked as demo) so the UI isn't empty.
 *
 * Always: mirrors the candidate profile into the DB and seeds the master resume.
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as bcrypt from 'bcryptjs';
import { CommonModule } from '../src/common/common.module';
import { PrismaService } from '../src/common/prisma.service';
import { DomainModule } from '../src/modules/domain.module';
import { JobsService } from '../src/modules/jobs/jobs.service';
import { ProfileService } from '../src/modules/profile/profile.service';
import { QueuesModule } from '../src/modules/queues/queues.module';
import { ResumeService } from '../src/modules/resume/resume.service';
import { ContactsService } from '../src/modules/contacts/contacts.service';

@Module({ imports: [CommonModule, QueuesModule, DomainModule] })
class SeedModule {}

const DEMO_JOBS = [
  {
    title: 'Senior Backend Engineer (Demo)',
    companyName: 'Demo Commerce Co',
    location: 'Remote (India)',
    description: `DEMO JOB — created by the seed script.

We are hiring a Senior Backend Engineer to build the APIs behind our commerce platform.

Requirements:
- 3+ years of experience building backend systems
- Strong Node.js and TypeScript (NestJS is a plus)
- PostgreSQL or MySQL, Redis
- Message queues / background jobs (BullMQ, SQS or Kafka)
- AWS (EC2, RDS, S3)
- Third-party integrations and payment gateways

Nice to have:
- Kafka
- Kubernetes

Fully remote within India. Compensation: ₹35-45 LPA.
Apply by writing to careers@demo-commerce.example.com`,
  },
  {
    title: 'Backend Engineer, Platform (Demo)',
    companyName: 'Demo Logistics',
    location: 'Bengaluru, India',
    description: `DEMO JOB — created by the seed script.

Join our platform team building driver and fleet management services.

What you'll do:
- Design REST and GraphQL APIs in Node.js / TypeScript
- Own background processing with queues and Redis caching
- Improve observability (CloudWatch, alerting) and production debugging

Requirements:
- 2-5 years of backend experience
- MySQL, Redis, Docker, AWS
Hybrid, Bengaluru.`,
  },
  {
    title: 'Senior Java Engineer (Demo)',
    companyName: 'Demo Bank',
    location: 'Berlin, Germany',
    description: `DEMO JOB — created by the seed script.

Requirements:
- 7+ years of Java and Spring Boot
- Kafka, Cassandra, Kubernetes, Terraform
Must be located in the EU. We are unable to sponsor visas.`,
  },
];

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(SeedModule, { logger: ['error', 'warn'] });
  const prisma = app.get(PrismaService);
  try {
    const email = process.env.SEED_USER_EMAIL?.trim().toLowerCase();
    const password = process.env.SEED_USER_PASSWORD;
    let user = email ? await prisma.user.findUnique({ where: { email } }) : await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!user && email && password) {
      if (password.length < 10) throw new Error('SEED_USER_PASSWORD must be at least 10 characters');
      user = await prisma.user.create({ data: { email, passwordHash: await bcrypt.hash(password, 12), name: process.env.SEED_USER_NAME ?? email.split('@')[0] } });
      console.log(`Created user ${email}`);
    }
    if (!user) {
      console.log('No user yet — register in the web app (first account), then re-run the seed if you want demo data.');
      return;
    }
    await app.get(ProfileService).syncToDb(user.id);
    const master = await app.get(ResumeService).getMaster(user.id);
    console.log(`Profile mirrored; master resume ${master.id} (${master.source})`);

    if (process.env.SEED_DEMO === 'true') {
      const jobs = app.get(JobsService);
      for (const j of DEMO_JOBS) {
        const r = await jobs.createManual(user.id, j, 'MANUAL');
        console.log(`${r.duplicate ? 'Exists' : 'Created'}: ${j.title} → score ${r.score} (${r.recommendation})`);
        if (!r.duplicate && j.companyName === 'Demo Commerce Co') {
          await app.get(ContactsService).discover(user.id, r.jobId);
        }
      }
    }
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
