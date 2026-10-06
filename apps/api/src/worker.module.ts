import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { CommonModule } from './common/common.module';
import { loggerParams } from './common/logger';
import { loadEnv } from './config/env';
import { DomainModule } from './modules/domain.module';
import { PROCESSORS } from './modules/queues/processors';
import { QueuesModule } from './modules/queues/queues.module';

/** Background worker process: BullMQ processors + schedules. Same code base as the API. */
@Module({
  imports: [LoggerModule.forRoot(loggerParams(loadEnv(), 'worker')), CommonModule, QueuesModule, DomainModule],
  providers: [...PROCESSORS],
})
export class WorkerModule {}
