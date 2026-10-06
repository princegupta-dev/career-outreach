import { Global, Module } from '@nestjs/common';
import { ENV, loadEnv } from '../config/env';
import { AuditService } from './audit.service';
import { Encryptor } from './crypto';
import { MetricsService } from './metrics.service';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';

export const ENCRYPTOR = Symbol('ENCRYPTOR');

@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: () => loadEnv() },
    { provide: ENCRYPTOR, useFactory: () => new Encryptor(loadEnv().ENCRYPTION_KEY) },
    PrismaService,
    RedisService,
    MetricsService,
    AuditService,
  ],
  exports: [ENV, ENCRYPTOR, PrismaService, RedisService, MetricsService, AuditService],
})
export class CommonModule {}
