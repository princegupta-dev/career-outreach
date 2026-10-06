import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { AuthUser, CurrentUser, Public } from '../../common/http';
import { MetricsService } from '../../common/metrics.service';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import { AiService } from '../ai/ai.service';
import { QueueService } from '../queues/queues';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly queues: QueueService,
    private readonly metrics: MetricsService,
    private readonly ai: AiService,
  ) {}

  @Public()
  @Get()
  async health() {
    const checks: Record<string, string> = {};
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch {
      checks.database = 'down';
    }
    try {
      checks.redis = (await this.redis.client.ping()) === 'PONG' ? 'ok' : 'down';
    } catch {
      checks.redis = 'down';
    }
    if (Object.values(checks).some((v) => v !== 'ok')) throw new ServiceUnavailableException({ status: 'degraded', checks });
    return { status: 'ok', checks };
  }

  /** Operational view: queue depth, daily metric counters, recent failures. */
  @Get('metrics')
  async details(@CurrentUser() user: AuthUser) {
    const since = new Date(Date.now() - 7 * 86_400_000);
    const [queues, metrics, aiFailures, sendFailures, aiStats] = await Promise.all([
      this.queues.counts(),
      this.metrics.snapshot(7),
      this.prisma.aiGeneration.findMany({ where: { userId: user.id, status: 'FAILED', createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 10, select: { kind: true, error: true, createdAt: true } }),
      this.prisma.emailEvent.findMany({ where: { userId: user.id, type: 'SEND_FAILED', occurredAt: { gte: since } }, orderBy: { occurredAt: 'desc' }, take: 10, select: { outreachId: true, metadata: true, occurredAt: true } }),
      this.prisma.aiGeneration.aggregate({ where: { userId: user.id, createdAt: { gte: since }, provider: { not: 'template' } }, _avg: { latencyMs: true }, _sum: { inputTokens: true, outputTokens: true }, _count: true }),
    ]);
    return {
      ai: { ...this.ai.status(), last7Days: { calls: aiStats._count, avgLatencyMs: Math.round(aiStats._avg.latencyMs ?? 0), inputTokens: aiStats._sum.inputTokens ?? 0, outputTokens: aiStats._sum.outputTokens ?? 0 } },
      queues,
      metrics,
      recentFailures: { ai: aiFailures, email: sendFailures },
    };
  }
}
