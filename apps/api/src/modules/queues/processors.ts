import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { DelayedError, Job } from 'bullmq';
import { requestContext } from '../../common/context';
import { MetricsService } from '../../common/metrics.service';
import { PrismaService } from '../../common/prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { DiscoveryService } from '../discovery/discovery.service';
import { EmailSyncService } from '../email/email-sync.service';
import { FollowupRunnerService } from '../followups/followup-runner.service';
import { JobsService } from '../jobs/jobs.service';
import { OutreachService, RetryLaterError } from '../outreach/outreach.service';
import { ResumeService } from '../resume/resume.service';
import { BaseJobData, DiscoveryJobData, EmailGenJobData, ProcessJobData, QUEUES, ResumeJobData, SendJobData } from './queues';

/** Shared wrapper: correlation id, structured logs, failure metrics. */
abstract class BaseProcessor<T extends BaseJobData = BaseJobData> extends WorkerHost {
  protected abstract readonly logger: Logger;
  protected abstract handle(job: Job<T>, token?: string): Promise<unknown>;

  constructor(protected readonly metrics: MetricsService) {
    super();
  }

  async process(job: Job<T>, token?: string): Promise<unknown> {
    return requestContext.run({ correlationId: job.data.correlationId ?? `job-${job.queueName}-${job.id}`, userId: job.data.userId }, async () => {
      const started = Date.now();
      try {
        const result = await this.handle(job, token);
        this.logger.log({ msg: 'job completed', queue: job.queueName, jobId: job.id, ms: Date.now() - started });
        return result;
      } catch (err) {
        if (err instanceof RetryLaterError && token) {
          this.logger.log({ msg: 'job deferred', queue: job.queueName, jobId: job.id, reason: err.message, delayMs: err.delayMs });
          await job.moveToDelayed(Date.now() + err.delayMs, token);
          throw new DelayedError();
        }
        if (err instanceof DelayedError) throw err;
        await this.metrics.record('queue.failure', { queue: job.queueName, jobId: job.id, attempt: job.attemptsMade + 1, error: (err as Error).message });
        throw err;
      }
    });
  }
}

@Processor(QUEUES.jobProcessing, { concurrency: 4 })
export class JobProcessingProcessor extends BaseProcessor<ProcessJobData> {
  protected readonly logger = new Logger('JobProcessingWorker');
  constructor(
    metrics: MetricsService,
    private readonly jobs: JobsService,
  ) {
    super(metrics);
  }
  protected async handle(job: Job<ProcessJobData>) {
    const scored = await this.jobs.score(job.data.jobId);
    if (job.data.analyze) await this.jobs.analyze(job.data.userId, job.data.jobId);
    return scored;
  }
}

@Processor(QUEUES.discovery, { concurrency: 1, lockDuration: 10 * 60_000 })
export class DiscoveryProcessor extends BaseProcessor<DiscoveryJobData> {
  protected readonly logger = new Logger('DiscoveryWorker');
  constructor(
    metrics: MetricsService,
    private readonly jobs: JobsService,
    private readonly discovery: DiscoveryService,
    private readonly prisma: PrismaService,
  ) {
    super(metrics);
  }
  protected async handle(job: Job<DiscoveryJobData>) {
    if (job.data.sourceId) return this.jobs.runSource(job.data.userId, job.data.sourceId);
    // Daily schedule: every user. Otherwise: one user's full run (manual / sign-up / start-up).
    const users = job.data.userId === '*' ? (await this.prisma.user.findMany({ select: { id: true } })).map((u) => u.id) : [job.data.userId];
    const out = [];
    for (const userId of users) out.push(await this.discovery.runAll(userId, job.data.userId === '*' ? 'schedule' : (job.data.trigger ?? 'manual')));
    return out.map(({ errors, ...rest }) => ({ ...rest, errors: errors.length }));
  }
}

@Processor(QUEUES.resume, { concurrency: 2 })
export class ResumeProcessor extends BaseProcessor<ResumeJobData> {
  protected readonly logger = new Logger('ResumeWorker');
  constructor(
    metrics: MetricsService,
    private readonly resumes: ResumeService,
  ) {
    super(metrics);
  }
  protected async handle(job: Job<ResumeJobData>) {
    const r = await this.resumes.tailor(job.data.userId, job.data.jobId, { useAi: job.data.useAi });
    return { versionId: r.version.id, reused: r.reused };
  }
}

@Processor(QUEUES.emailGeneration, { concurrency: 2 })
export class EmailGenerationProcessor extends BaseProcessor<EmailGenJobData> {
  protected readonly logger = new Logger('EmailGenerationWorker');
  constructor(
    metrics: MetricsService,
    private readonly outreach: OutreachService,
  ) {
    super(metrics);
  }
  protected async handle(job: Job<EmailGenJobData>) {
    const o = await this.outreach.generateInitial(job.data.userId, job.data.applicationId);
    return { outreachId: o.id };
  }
}

/** Serial sending (concurrency 1) keeps spacing predictable. Idempotent — see OutreachService.sendNow. */
@Processor(QUEUES.emailSend, { concurrency: 1 })
export class EmailSendProcessor extends BaseProcessor<SendJobData> {
  protected readonly logger = new Logger('EmailSendWorker');
  constructor(
    metrics: MetricsService,
    private readonly outreach: OutreachService,
    private readonly analytics: AnalyticsService,
  ) {
    super(metrics);
  }
  protected async handle(job: Job<SendJobData>) {
    const r = await this.outreach.sendNow(job.data.outreachId);
    if (r.status === 'sent') await this.analytics.invalidate(job.data.userId);
    return r;
  }
}

@Processor(QUEUES.emailSync, { concurrency: 1 })
export class EmailSyncProcessor extends BaseProcessor {
  protected readonly logger = new Logger('EmailSyncWorker');
  constructor(
    metrics: MetricsService,
    private readonly outreach: OutreachService,
    private readonly sync: EmailSyncService,
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
  ) {
    super(metrics);
  }
  protected async handle(job: Job<BaseJobData>) {
    const users = job.data.userId === '*' ? (await this.prisma.emailAccount.findMany({ where: { status: 'CONNECTED' }, distinct: ['userId'], select: { userId: true } })).map((u) => u.userId) : [job.data.userId];
    const out: Record<string, unknown> = {};
    for (const userId of users) {
      const drafts = await this.outreach.reconcileDrafts(userId);
      out[userId] = { ...(await this.sync.syncUser(userId)), ...drafts };
      await this.analytics.invalidate(userId);
    }
    return out;
  }
}

@Processor(QUEUES.followups, { concurrency: 1 })
export class FollowupProcessor extends BaseProcessor {
  protected readonly logger = new Logger('FollowupWorker');
  constructor(
    metrics: MetricsService,
    private readonly runner: FollowupRunnerService,
  ) {
    super(metrics);
  }
  protected handle() {
    return this.runner.tick();
  }
}

@Processor(QUEUES.analytics, { concurrency: 1 })
export class AnalyticsProcessor extends BaseProcessor {
  protected readonly logger = new Logger('AnalyticsWorker');
  constructor(
    metrics: MetricsService,
    private readonly analytics: AnalyticsService,
    private readonly prisma: PrismaService,
  ) {
    super(metrics);
  }
  protected async handle() {
    const users = await this.prisma.user.findMany({ select: { id: true } });
    for (const u of users) await this.analytics.get(u.id, true);
    return { users: users.length };
  }
}

export const PROCESSORS = [
  JobProcessingProcessor,
  DiscoveryProcessor,
  ResumeProcessor,
  EmailGenerationProcessor,
  EmailSendProcessor,
  EmailSyncProcessor,
  FollowupProcessor,
  AnalyticsProcessor,
];
