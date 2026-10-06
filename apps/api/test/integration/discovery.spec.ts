import type { INestApplicationContext } from '@nestjs/common';
import { PrismaService } from '../../src/common/prisma.service';
import { DiscoveryService } from '../../src/modules/discovery/discovery.service';
import { EmailAccountsService } from '../../src/modules/email/email-accounts.service';
import { JobsService } from '../../src/modules/jobs/jobs.service';
import { createContext, createUser, flushRedis, resetDatabase } from '../setup/helpers';
import { installMockWeb } from '../setup/mock-web';

describe('Autonomous discovery (integration, mocked internet)', () => {
  let ctx: INestApplicationContext;
  let prisma: PrismaService;
  let userId: string;
  let web: ReturnType<typeof installMockWeb>;

  beforeAll(async () => {
    ctx = await createContext();
    prisma = ctx.get(PrismaService);
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    await flushRedis();
    userId = (await createUser(prisma)).id;
    web = installMockWeb();
    // Default sources + one test board (the curated boards 404 in the mock).
    await ctx.get(JobsService).ensureDefaultSources(userId);
    await prisma.jobSource.create({ data: { userId, provider: 'GREENHOUSE', name: 'AcmeCorp', config: { boardToken: 'acmecorp', companyName: 'AcmeCorp', domain: 'acmecorp.com' } } });
  });
  afterEach(() => web.restore());
  afterAll(async () => ctx.close());

  it('finds, filters, de-duplicates and scores jobs from all sources without any manual input', async () => {
    const discovery = ctx.get(DiscoveryService);
    const run = await discovery.runAll(userId, 'manual');

    expect(run.sources).toBeGreaterThan(40);
    expect(run.created).toBe(3); // HN Paylane, WWR Ledgerly, Greenhouse Bengaluru role
    expect(run.relevant).toBeGreaterThanOrEqual(2);
    const titles = (await prisma.job.findMany({ include: { company: true } })).map((j) => `${j.company.name} — ${j.title}`).sort();
    expect(titles).toEqual(['AcmeCorp — Senior Software Engineer, Backend', 'Ledgerly — Senior Node.js Backend Engineer', 'Paylane — Senior Backend Engineer']);
    // US-only, frontend and designer roles were filtered out before scoring; the SF role was never fetched in full.
    expect(web.urls).not.toContain('https://boards-api.greenhouse.io/v1/boards/acmecorp/jobs/12');

    // Blocked feeds are reported, not silently ignored.
    const blocked = run.errors.filter((e) => /Blocked by your network/.test(e.error)).map((e) => e.source);
    expect(blocked).toEqual(expect.arrayContaining(['Remotive', 'Himalayas', 'Remote OK']));
    const remotive = await prisma.jobSource.findFirstOrThrow({ where: { userId, provider: 'REMOTIVE' } });
    expect(remotive.lastError).toMatch(/HTTPS inspection/);
    const hn = await prisma.jobSource.findFirstOrThrow({ where: { userId, provider: 'HN_HIRING' } });
    expect(hn.lastStats).toMatchObject({ fetched: 3, afterBasicFilters: 1, created: 1 });

    // The contact published in the HN post was stored, honestly labelled.
    const contact = await prisma.contact.findFirstOrThrow({ where: { emailNormalized: 'cto@paylane.dev' } });
    expect(contact).toMatchObject({ confidence: 'VERIFIED', source: 'hn_hiring', roleCategory: 'CTO' });

    // Re-running finds nothing new (dedupe by source + content hash).
    const again = await discovery.runAll(userId, 'manual');
    expect(again.created).toBe(0);
    expect(again.duplicates).toBeGreaterThanOrEqual(3);
    expect(await prisma.job.count()).toBe(3);
  });

  it('prepares the best matches: contact + tailored resume + email draft in the mailbox (never sends)', async () => {
    await prisma.user.update({ where: { id: userId }, data: { settings: { automation: { dailyPrepareLimit: 5, minScoreToPrepare: 60 } } } });
    const run = await ctx.get(DiscoveryService).runAll(userId, 'manual');
    expect(run.prepared).toBeGreaterThanOrEqual(2);

    const prepared = await prisma.application.findMany({ where: { autoPreparedAt: { not: null } }, include: { contact: true, outreach: true, job: { include: { company: true } } } });
    const paylane = prepared.find((a) => a.job.company.name === 'Paylane')!;
    expect(paylane.contact?.email).toBe('cto@paylane.dev');
    expect(paylane.resumeVersionId).toBeTruthy();
    expect(paylane.outreach[0]).toMatchObject({ status: 'DRAFT', kind: 'INITIAL' });
    expect(paylane.outreach[0].gmailDraftId).toBeTruthy();
    expect(paylane.outreach[0].body).toMatch(/^Hi Paylane team,/);

    const acme = prepared.find((a) => a.job.company.name === 'AcmeCorp')!;
    expect(acme.contact?.email).toBe('careers@acmecorp.com'); // hiring inbox from the company website; personal address ignored
    expect(await prisma.contact.count({ where: { emailNormalized: 'jane.doe@acmecorp.com' } })).toBe(0);

    // Drafts exist in the (sandbox) mailbox with the tailored PDF attached; nothing was sent.
    const accounts = ctx.get(EmailAccountsService);
    const account = await prisma.emailAccount.findFirstOrThrow({ where: { userId } });
    const drafts = await accounts.sandbox.listDrafts(accounts.mailbox(account));
    expect(drafts.length).toBe(prepared.filter((a) => a.outreach.length).length);
    expect(drafts[0].attachments[0]).toMatch(/Resume\.pdf$/);
    expect(await prisma.outreach.count({ where: { status: 'SENT' } })).toBe(0);

    // Daily limit respected on the next run.
    const next = await ctx.get(DiscoveryService).prepareTop(userId);
    expect(next.prepared).toBe(0);

    // Dashboard headline data.
    const today = await ctx.get(DiscoveryService).today(userId);
    expect(today.relevant).toBeGreaterThanOrEqual(2);
    expect(today.readyToSend).toBeGreaterThanOrEqual(2);
    expect(today.jobs[0].score).toBeGreaterThanOrEqual(today.jobs[today.jobs.length - 1].score ?? 0);
  });
});
