import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { LoggerModule } from 'nestjs-pino';
import { CommonModule } from './common/common.module';
import { AllExceptionsFilter, AuthGuard, contextMiddleware, CsrfGuard, RateLimitGuard } from './common/http';
import { loggerParams } from './common/logger';
import { loadEnv } from './config/env';
import { AuthController } from './modules/auth/auth.controller';
import { AuthService } from './modules/auth/auth.service';
import { ContactsController } from './modules/contacts/contacts.controller';
import { DashboardController } from './modules/dashboard/dashboard.controller';
import { DiscoveryController } from './modules/discovery/discovery.controller';
import { DomainModule } from './modules/domain.module';
import { EmailController } from './modules/email/email.controller';
import { HealthController } from './modules/health/health.controller';
import { JobsController } from './modules/jobs/jobs.controller';
import { OutreachController } from './modules/outreach/outreach.controller';
import { ProfileController } from './modules/profile/profile.controller';
import { QueuesModule } from './modules/queues/queues.module';
import { ResumeController } from './modules/resume/resume.controller';

@Module({
  imports: [
    LoggerModule.forRoot(loggerParams(loadEnv(), 'api')),
    CommonModule,
    QueuesModule,
    DomainModule,
    JwtModule.register({ secret: loadEnv().SESSION_SECRET, signOptions: { algorithm: 'HS256', issuer: 'job-hunter' }, verifyOptions: { algorithms: ['HS256'], issuer: 'job-hunter' } }),
  ],
  controllers: [AuthController, ProfileController, JobsController, ContactsController, ResumeController, OutreachController, EmailController, DashboardController, DiscoveryController, HealthController],
  providers: [
    AuthService,
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Order matters: rate limit → auth → CSRF.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(contextMiddleware).forRoutes('*');
  }
}
