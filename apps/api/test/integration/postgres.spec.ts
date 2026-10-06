import type { INestApplicationContext } from '@nestjs/common';
import { PrismaService } from '../../src/common/prisma.service';
import { AiService } from '../../src/modules/ai/ai.service';
import { AiProviderError } from '../../src/providers/ai/anthropic.provider';
import { ContactsService } from '../../src/modules/contacts/contacts.service';
import { JobsService } from '../../src/modules/jobs/jobs.service';
import { ResumeService } from '../../src/modules/resume/resume.service';
import { BACKEND_JD, createContext, createUser, flushRedis, resetDatabase } from '../setup/helpers';

describe('PostgreSQL integration', () => {
  let ctx: INestApplicationContext;
  let prisma: PrismaService;
  let userId: string;

  beforeAll(async () => {
    ctx = await createContext();
    prisma = ctx.get(PrismaService);
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    await flushRedis();
    userId = (await createUser(prisma)).id;
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('deduplicates jobs by content hash and source hash (DB unique constraints)', async () => {
    const jobs = ctx.get(JobsService);
    const a = await jobs.createManual(userId, { title: 'Senior Backend Engineer', companyName: 'AcmePay', description: BACKEND_JD });
    const b = await jobs.createManual(userId, { title: 'Senior Backend Engineer ', companyName: 'AcmePay Inc.', description: `${BACKEND_JD}  ` });
    expect(b.duplicate).toBe(true);
    expect(b.jobId).toBe(a.jobId);
    expect(await prisma.job.count()).toBe(1);

    const c = await jobs.ingest(userId, { provider: 'GREENHOUSE', externalId: 'acme:1', url: 'https://boards.greenhouse.io/acme/jobs/1', title: 'Platform Engineer', companyName: 'AcmePay', description: `${BACKEND_JD}\nPlatform team.` });
    const d = await jobs.ingest(userId, { provider: 'GREENHOUSE', externalId: 'acme:1', url: 'https://boards.greenhouse.io/acme/jobs/1?gh_src=x', title: 'Platform Engineer (updated)', companyName: 'AcmePay', description: `${BACKEND_JD}\nPlatform team. Updated.` });
    expect(d.duplicate).toBe(true);
    expect(d.jobId).toBe(c.jobId);
    // Raw insert with the same content hash must be rejected by the database itself.
    const existing = await prisma.job.findUniqueOrThrow({ where: { id: a.jobId } });
    await expect(
      prisma.job.create({ data: { userId, companyId: existing.companyId, provider: 'MANUAL', title: 'x', description: 'y', contentHash: existing.contentHash } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('creates an application and scores the job deterministically on ingest', async () => {
    const r = await ctx.get(JobsService).createManual(userId, { title: 'Senior Backend Engineer', companyName: 'AcmePay', description: BACKEND_JD, location: 'Remote' });
    const job = await prisma.job.findUniqueOrThrow({ where: { id: r.jobId }, include: { application: true } });
    expect(job.score).toBeGreaterThanOrEqual(80);
    expect(job.recommendation).toBe('STRONG_APPLY');
    expect(job.application?.status).toBe('QUALIFIED');
    expect(job.scoredWith).toBeTruthy();
    // Re-scoring with unchanged inputs is a no-op.
    expect((await ctx.get(JobsService).score(r.jobId)).skipped).toBe(true);
  });

  it('stores contacts uniquely per company + email and never downgrades confidence', async () => {
    const r = await ctx.get(JobsService).createManual(userId, { title: 'Senior Backend Engineer', companyName: 'AcmePay', description: BACKEND_JD });
    const contacts = ctx.get(ContactsService);
    const first = await contacts.discover(userId, r.jobId);
    expect(first.contacts).toHaveLength(1);
    expect(first.contacts[0]).toMatchObject({ name: 'Sarah Lee', email: 'sarah.lee@acmepay.io', confidence: 'VERIFIED', roleCategory: 'ENGINEERING_MANAGER' });
    const job = await prisma.job.findUniqueOrThrow({ where: { id: r.jobId } });
    await contacts.create(userId, job.companyId, { name: 'Sarah Lee', email: 'SARAH.LEE@acmepay.io', confidence: 'UNVERIFIED' });
    const all = await prisma.contact.findMany();
    expect(all).toHaveLength(1);
    expect(all[0].confidence).toBe('VERIFIED');
  });

  it('caches AI generations by input hash (no repeated calls)', async () => {
    const ai = ctx.get(AiService);
    let calls = 0;
    const call = async () => {
      calls++;
      return { output: { value: 42 }, usage: { model: 'test' } };
    };
    const a = await ai.run(userId, 'JOB_ANALYSIS', { jd: 'same' }, call);
    const b = await ai.run(userId, 'JOB_ANALYSIS', { jd: 'same' }, call);
    const c = await ai.run(userId, 'JOB_ANALYSIS', { jd: 'different' }, call);
    expect(calls).toBe(2);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(c.cached).toBe(false);
    expect(await prisma.aiGeneration.count({ where: { status: 'SUCCESS' } })).toBe(2);
  });

  it('pauses LLM calls after a billing error and falls back to templates (circuit breaker)', async () => {
    const ai = ctx.get(AiService);
    let llmCalls = 0;
    const fakeLlm = {
      name: 'anthropic',
      isLlm: true,
      analyzeJob: async () => {
        llmCalls++;
        throw new AiProviderError('Anthropic rejected the request: 400 Your credit balance is too low to access the Anthropic API.', false);
      },
    };
    Object.defineProperty(ai, 'primary', { value: fakeLlm, configurable: true });
    try {
      const call = (p: { name: string; analyzeJob: () => Promise<{ output: unknown; usage: { model: string } }> }) =>
        p.name === 'template' ? Promise.resolve({ output: { fallback: true }, usage: { model: 'template' } }) : p.analyzeJob();
      const first = await ai.run(userId, 'JOB_ANALYSIS', { n: 1 }, call as never);
      expect(first.fallback).toBe(true);
      expect((await ai.circuit()).open).toBe(true);
      const second = await ai.run(userId, 'JOB_ANALYSIS', { n: 2 }, call as never);
      expect(second.fallback).toBe(true);
      expect(llmCalls).toBe(1); // second call never reached the API
    } finally {
      Object.defineProperty(ai, 'primary', { value: ai.template, configurable: true });
    }
  });

  it('reuses tailored resume versions while inputs are unchanged', async () => {
    const r = await ctx.get(JobsService).createManual(userId, { title: 'Senior Backend Engineer', companyName: 'AcmePay', description: BACKEND_JD });
    const resumes = ctx.get(ResumeService);
    const v1 = await resumes.tailor(userId, r.jobId);
    const v2 = await resumes.tailor(userId, r.jobId);
    expect(v1.reused).toBe(false);
    expect(v2.reused).toBe(true);
    expect(v2.version.id).toBe(v1.version.id);
    // Changing the master resume invalidates the cache.
    const master = await resumes.getMaster(userId);
    master.data.basics.headline = 'Backend Engineer';
    await resumes.saveMaster(userId, master.data);
    const v3 = await resumes.tailor(userId, r.jobId);
    expect(v3.reused).toBe(false);
    expect(await prisma.resumeVersion.count()).toBe(2);
    const app = await prisma.application.findFirstOrThrow();
    expect(app.status).toBe('RESUME_READY');
  });

  it('soft-deletes jobs and restores them on re-import', async () => {
    const jobs = ctx.get(JobsService);
    const r = await jobs.createManual(userId, { title: 'Senior Backend Engineer', companyName: 'AcmePay', description: BACKEND_JD });
    await jobs.remove(userId, r.jobId);
    expect((await jobs.list(userId, {})).total).toBe(0);
    const again = await jobs.createManual(userId, { title: 'Senior Backend Engineer', companyName: 'AcmePay', description: BACKEND_JD });
    expect(again).toMatchObject({ jobId: r.jobId, duplicate: true });
    expect((await jobs.list(userId, {})).total).toBe(1);
  });
});
