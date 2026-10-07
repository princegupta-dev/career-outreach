import { Module } from '@nestjs/common';
import { AiService } from './ai/ai.service';
import { AnalyticsService } from './analytics/analytics.service';
import { ApplicationsService } from './applications/applications.service';
import { PipelineService } from './applications/pipeline.service';
import { CompaniesService } from './companies/companies.service';
import { ContactsService } from './contacts/contacts.service';
import { DiscoveryService } from './discovery/discovery.service';
import { EmailAccountsService } from './email/email-accounts.service';
import { EmailSyncService } from './email/email-sync.service';
import { FollowupRunnerService } from './followups/followup-runner.service';
import { FollowupsService } from './followups/followups.service';
import { JobsService } from './jobs/jobs.service';
import { OutreachService } from './outreach/outreach.service';
import { ProfileService } from './profile/profile.service';
import { ResumeService } from './resume/resume.service';
import { SettingsService } from './settings/settings.service';

const SERVICES = [
  AiService,
  AnalyticsService,
  ApplicationsService,
  CompaniesService,
  ContactsService,
  DiscoveryService,
  EmailAccountsService,
  EmailSyncService,
  FollowupRunnerService,
  FollowupsService,
  JobsService,
  OutreachService,
  PipelineService,
  ProfileService,
  ResumeService,
  SettingsService,
];

/** All business services — shared by the HTTP API and the worker process. */
@Module({ providers: SERVICES, exports: SERVICES })
export class DomainModule {}
