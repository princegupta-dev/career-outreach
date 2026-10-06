import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';
import { requestContext } from '../../common/context';

export const QUEUES = {
  discovery: 'discovery',
  jobProcessing: 'job-processing',
  resume: 'resume-generation',
  emailGeneration: 'email-generation',
  emailSend: 'email-send',
  emailSync: 'email-sync',
  followups: 'followups',
  analytics: 'analytics',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: { count: 1000, age: 7 * 24 * 3600 },
  removeOnFail: { count: 5000, age: 30 * 24 * 3600 },
};

/** Every job carries the correlation id of the request that created it. */
export interface BaseJobData {
  correlationId?: string;
  userId: string;
}

export interface ProcessJobData extends BaseJobData {
  jobId: string;
  analyze?: boolean;
}
export interface DiscoveryJobData extends BaseJobData {
  sourceId?: string;
  trigger?: 'schedule' | 'manual' | 'startup' | 'signup';
}
export interface ResumeJobData extends BaseJobData {
  jobId: string;
  useAi?: boolean;
}
export interface EmailGenJobData extends BaseJobData {
  applicationId: string;
}
export interface SendJobData extends BaseJobData {
  outreachId: string;
}

/**
 * Producer facade. Job IDs are deterministic where duplicates would be harmful
 * (e.g. one send job per outreach row), so re-enqueueing is a no-op.
 */
@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    @InjectQueue(QUEUES.discovery) private readonly discovery: Queue,
    @InjectQueue(QUEUES.jobProcessing) private readonly jobProcessing: Queue,
    @InjectQueue(QUEUES.resume) private readonly resume: Queue,
    @InjectQueue(QUEUES.emailGeneration) private readonly emailGeneration: Queue,
    @InjectQueue(QUEUES.emailSend) private readonly emailSend: Queue,
    @InjectQueue(QUEUES.emailSync) private readonly emailSync: Queue,
    @InjectQueue(QUEUES.followups) private readonly followups: Queue,
    @InjectQueue(QUEUES.analytics) private readonly analytics: Queue,
  ) {}

  private data<T extends BaseJobData>(d: T): T {
    return { ...d, correlationId: d.correlationId ?? requestContext.correlationId() };
  }

  all(): Record<string, Queue> {
    return {
      [QUEUES.discovery]: this.discovery,
      [QUEUES.jobProcessing]: this.jobProcessing,
      [QUEUES.resume]: this.resume,
      [QUEUES.emailGeneration]: this.emailGeneration,
      [QUEUES.emailSend]: this.emailSend,
      [QUEUES.emailSync]: this.emailSync,
      [QUEUES.followups]: this.followups,
      [QUEUES.analytics]: this.analytics,
    };
  }

  async processJob(d: ProcessJobData): Promise<void> {
    await this.jobProcessing.add('process', this.data(d), { ...DEFAULT_JOB_OPTIONS, jobId: `process-${d.jobId}-${d.analyze ? 'ai' : 'det'}`, attempts: 3 });
  }

  async discover(d: DiscoveryJobData): Promise<void> {
    const minute = Math.floor(Date.now() / 60000);
    await this.discovery.add('discover', this.data(d), {
      ...DEFAULT_JOB_OPTIONS,
      attempts: 1,
      jobId: d.sourceId ? `discover-${d.sourceId}-${minute}` : `discover-all-${d.userId}-${minute}`,
    });
  }

  async tailorResume(d: ResumeJobData): Promise<void> {
    await this.resume.add('tailor', this.data(d), { ...DEFAULT_JOB_OPTIONS, attempts: 3 });
  }

  async generateEmail(d: EmailGenJobData): Promise<void> {
    await this.emailGeneration.add('generate', this.data(d), { ...DEFAULT_JOB_OPTIONS, attempts: 3 });
  }

  /** One send job per outreach row: duplicate enqueues are ignored by BullMQ. */
  async send(d: SendJobData, delayMs = 0): Promise<void> {
    const jobId = `send-${d.outreachId}`;
    const existing = await this.emailSend.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'completed' || state === 'failed') await existing.remove().catch(() => undefined);
      else return;
    }
    await this.emailSend.add('send', this.data(d), { ...DEFAULT_JOB_OPTIONS, jobId, delay: delayMs, attempts: 6 });
  }

  async cancelSend(outreachId: string): Promise<void> {
    const job = await this.emailSend.getJob(`send-${outreachId}`);
    if (job && ['waiting', 'delayed'].includes(await job.getState())) await job.remove().catch(() => undefined);
  }

  async syncNow(userId: string): Promise<void> {
    await this.emailSync.add('sync', this.data({ userId }), { ...DEFAULT_JOB_OPTIONS, attempts: 2, jobId: `sync-${userId}-${Math.floor(Date.now() / 30000)}` });
  }

  async counts(): Promise<Record<string, Record<string, number>>> {
    const out: Record<string, Record<string, number>> = {};
    for (const [name, q] of Object.entries(this.all())) {
      out[name] = await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
    }
    return out;
  }
}
