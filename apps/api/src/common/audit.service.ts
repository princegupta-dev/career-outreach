import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { requestContext } from './context';
import { PrismaService } from './prisma.service';

/** Append-only audit trail for security-relevant and state-changing actions. */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(action: string, args: { userId?: string | null; entityType?: string; entityId?: string; metadata?: Record<string, unknown> } = {}): Promise<void> {
    const ctx = requestContext.get();
    try {
      await this.prisma.auditLog.create({
        data: {
          action,
          userId: args.userId ?? ctx?.userId ?? null,
          entityType: args.entityType,
          entityId: args.entityId,
          metadata: (args.metadata ?? {}) as Prisma.InputJsonValue,
          requestId: ctx?.correlationId,
          ip: ctx?.ip,
        },
      });
    } catch (e) {
      this.logger.warn({ msg: 'audit log write failed', action, error: (e as Error).message });
    }
  }
}
