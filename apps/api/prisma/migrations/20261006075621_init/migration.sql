-- CreateEnum
CREATE TYPE "CompanySize" AS ENUM ('EARLY_STARTUP', 'GROWTH_STARTUP', 'MID_MARKET', 'ENTERPRISE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "JobProviderKind" AS ENUM ('MANUAL', 'PASTE', 'URL', 'GREENHOUSE', 'LEVER', 'ASHBY');

-- CreateEnum
CREATE TYPE "Recommendation" AS ENUM ('STRONG_APPLY', 'APPLY', 'CONSIDER', 'LOW_PRIORITY', 'SKIP');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('DISCOVERED', 'QUALIFIED', 'SHORTLISTED', 'CONTACT_FOUND', 'RESUME_READY', 'EMAIL_READY', 'EMAIL_SENT', 'WAITING_FOR_REPLY', 'FOLLOWUP_SCHEDULED', 'REPLIED', 'INTERVIEW', 'REJECTED', 'OFFER', 'CLOSED');

-- CreateEnum
CREATE TYPE "ContactRole" AS ENUM ('HIRING_MANAGER', 'ENGINEERING_MANAGER', 'TECHNICAL_RECRUITER', 'ENGINEERING_DIRECTOR', 'RECRUITER', 'HR', 'FOUNDER', 'CTO', 'ENGINEER', 'OTHER');

-- CreateEnum
CREATE TYPE "ContactConfidence" AS ENUM ('VERIFIED', 'LIKELY', 'UNVERIFIED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "OutreachKind" AS ENUM ('INITIAL', 'FOLLOWUP');

-- CreateEnum
CREATE TYPE "OutreachStatus" AS ENUM ('DRAFT', 'APPROVED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ThreadState" AS ENUM ('NOT_SENT', 'WAITING_FOR_REPLY', 'REPLIED', 'BOUNCED', 'CLOSED');

-- CreateEnum
CREATE TYPE "FollowupStatus" AS ENUM ('SCHEDULED', 'DRAFT_READY', 'APPROVED', 'SENT', 'CANCELLED', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "EmailProviderKind" AS ENUM ('GMAIL', 'SANDBOX');

-- CreateEnum
CREATE TYPE "EmailAccountStatus" AS ENUM ('CONNECTED', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "EmailEventType" AS ENUM ('DRAFT_CREATED', 'SENT', 'SEND_FAILED', 'REPLY_RECEIVED', 'AUTO_REPLY', 'BOUNCE', 'FOLLOWUP_CANCELLED', 'UNSUBSCRIBE');

-- CreateEnum
CREATE TYPE "AiKind" AS ENUM ('JOB_ANALYSIS', 'RESUME_TAILOR', 'RESUME_PARSE', 'EMAIL', 'FOLLOWUP');

-- CreateEnum
CREATE TYPE "AiStatus" AS ENUM ('SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "ResumeSource" AS ENUM ('SEED', 'IMPORT', 'MANUAL');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "markdown" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resumes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_master" BOOLEAN NOT NULL DEFAULT true,
    "data" JSONB NOT NULL,
    "source" "ResumeSource" NOT NULL DEFAULT 'MANUAL',
    "content_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "resumes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resume_versions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "resume_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "data" JSONB NOT NULL,
    "changes" JSONB NOT NULL DEFAULT '[]',
    "input_hash" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "ai_assisted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resume_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "companies" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "domain" TEXT,
    "website" TEXT,
    "size" "CompanySize" NOT NULL DEFAULT 'UNKNOWN',
    "company_type" TEXT,
    "location" TEXT,
    "description" TEXT,
    "research" JSONB,
    "researched_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_sources" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "JobProviderKind" NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_run_at" TIMESTAMP(3),
    "last_error" TEXT,
    "last_count" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "source_id" UUID,
    "provider" "JobProviderKind" NOT NULL,
    "external_id" TEXT,
    "url" TEXT,
    "title" TEXT NOT NULL,
    "location" TEXT,
    "remote" BOOLEAN,
    "employment_type" TEXT,
    "salary_min" INTEGER,
    "salary_max" INTEGER,
    "salary_currency" TEXT,
    "salary_period" TEXT,
    "description" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "source_hash" TEXT,
    "extracted" JSONB,
    "score" INTEGER,
    "score_breakdown" JSONB,
    "recommendation" "Recommendation",
    "scored_with" TEXT,
    "analysis" JSONB,
    "analysis_hash" TEXT,
    "posted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "role_category" "ContactRole" NOT NULL DEFAULT 'OTHER',
    "email" TEXT,
    "email_normalized" TEXT,
    "source" TEXT NOT NULL,
    "source_url" TEXT,
    "confidence" "ContactConfidence" NOT NULL DEFAULT 'UNKNOWN',
    "linkedin_url" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "contact_id" UUID,
    "resume_version_id" UUID,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'DISCOVERED',
    "status_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reply_sentiment" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "email_account_id" UUID,
    "resume_version_id" UUID,
    "root_id" UUID,
    "kind" "OutreachKind" NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "to_email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "style" TEXT NOT NULL DEFAULT 'concise',
    "attach_resume" BOOLEAN NOT NULL DEFAULT true,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "status" "OutreachStatus" NOT NULL DEFAULT 'DRAFT',
    "thread_state" "ThreadState" NOT NULL DEFAULT 'NOT_SENT',
    "message_id_header" TEXT NOT NULL,
    "gmail_message_id" TEXT,
    "gmail_thread_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "replied_at" TIMESTAMP(3),
    "send_attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "ai_generated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outreach_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "followups" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "root_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "status" "FollowupStatus" NOT NULL DEFAULT 'SCHEDULED',
    "outreach_id" UUID,
    "cancel_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "followups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "EmailProviderKind" NOT NULL,
    "email" TEXT NOT NULL,
    "access_token_enc" TEXT,
    "refresh_token_enc" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "scopes" TEXT,
    "status" "EmailAccountStatus" NOT NULL DEFAULT 'CONNECTED',
    "last_sync_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_events" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "outreach_id" UUID,
    "email_account_id" UUID,
    "type" "EmailEventType" NOT NULL,
    "provider_message_id" TEXT,
    "thread_id" TEXT,
    "from_email" TEXT,
    "snippet" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_generations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "AiKind" NOT NULL,
    "input_hash" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" "AiStatus" NOT NULL,
    "output" JSONB,
    "error" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "latency_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_generations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "request_id" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppressions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "value" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'email',
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "profiles_user_id_key" ON "profiles"("user_id");

-- CreateIndex
CREATE INDEX "resumes_user_id_is_master_idx" ON "resumes"("user_id", "is_master");

-- CreateIndex
CREATE INDEX "resume_versions_job_id_idx" ON "resume_versions"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "resume_versions_resume_id_job_id_input_hash_key" ON "resume_versions"("resume_id", "job_id", "input_hash");

-- CreateIndex
CREATE INDEX "companies_user_id_domain_idx" ON "companies"("user_id", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "companies_user_id_normalized_name_key" ON "companies"("user_id", "normalized_name");

-- CreateIndex
CREATE UNIQUE INDEX "job_sources_user_id_provider_name_key" ON "job_sources"("user_id", "provider", "name");

-- CreateIndex
CREATE INDEX "jobs_user_id_score_idx" ON "jobs"("user_id", "score");

-- CreateIndex
CREATE INDEX "jobs_user_id_recommendation_idx" ON "jobs"("user_id", "recommendation");

-- CreateIndex
CREATE INDEX "jobs_company_id_idx" ON "jobs"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_user_id_content_hash_key" ON "jobs"("user_id", "content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_user_id_source_hash_key" ON "jobs"("user_id", "source_hash");

-- CreateIndex
CREATE INDEX "contacts_user_id_email_normalized_idx" ON "contacts"("user_id", "email_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_user_id_company_id_email_normalized_key" ON "contacts"("user_id", "company_id", "email_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "applications_job_id_key" ON "applications"("job_id");

-- CreateIndex
CREATE INDEX "applications_user_id_status_idx" ON "applications"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "outreach_message_id_header_key" ON "outreach"("message_id_header");

-- CreateIndex
CREATE INDEX "outreach_user_id_status_idx" ON "outreach"("user_id", "status");

-- CreateIndex
CREATE INDEX "outreach_user_id_thread_state_idx" ON "outreach"("user_id", "thread_state");

-- CreateIndex
CREATE INDEX "outreach_gmail_thread_id_idx" ON "outreach"("gmail_thread_id");

-- CreateIndex
CREATE INDEX "outreach_user_id_sent_at_idx" ON "outreach"("user_id", "sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "outreach_application_id_contact_id_sequence_key" ON "outreach"("application_id", "contact_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "followups_outreach_id_key" ON "followups"("outreach_id");

-- CreateIndex
CREATE INDEX "followups_status_scheduled_at_idx" ON "followups"("status", "scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "followups_root_id_sequence_key" ON "followups"("root_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "email_accounts_user_id_provider_email_key" ON "email_accounts"("user_id", "provider", "email");

-- CreateIndex
CREATE INDEX "email_events_outreach_id_idx" ON "email_events"("outreach_id");

-- CreateIndex
CREATE INDEX "email_events_user_id_type_occurred_at_idx" ON "email_events"("user_id", "type", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_events_type_provider_message_id_key" ON "email_events"("type", "provider_message_id");

-- CreateIndex
CREATE INDEX "ai_generations_user_id_kind_input_hash_status_idx" ON "ai_generations"("user_id", "kind", "input_hash", "status");

-- CreateIndex
CREATE INDEX "ai_generations_created_at_idx" ON "ai_generations"("created_at");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "suppressions_user_id_value_key" ON "suppressions"("user_id", "value");

-- AddForeignKey
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resumes" ADD CONSTRAINT "resumes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resume_versions" ADD CONSTRAINT "resume_versions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resume_versions" ADD CONSTRAINT "resume_versions_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "resumes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resume_versions" ADD CONSTRAINT "resume_versions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_sources" ADD CONSTRAINT "job_sources_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "job_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_resume_version_id_fkey" FOREIGN KEY ("resume_version_id") REFERENCES "resume_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach" ADD CONSTRAINT "outreach_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach" ADD CONSTRAINT "outreach_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach" ADD CONSTRAINT "outreach_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach" ADD CONSTRAINT "outreach_email_account_id_fkey" FOREIGN KEY ("email_account_id") REFERENCES "email_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach" ADD CONSTRAINT "outreach_resume_version_id_fkey" FOREIGN KEY ("resume_version_id") REFERENCES "resume_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach" ADD CONSTRAINT "outreach_root_id_fkey" FOREIGN KEY ("root_id") REFERENCES "outreach"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "followups" ADD CONSTRAINT "followups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "followups" ADD CONSTRAINT "followups_root_id_fkey" FOREIGN KEY ("root_id") REFERENCES "outreach"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "followups" ADD CONSTRAINT "followups_outreach_id_fkey" FOREIGN KEY ("outreach_id") REFERENCES "outreach"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_outreach_id_fkey" FOREIGN KEY ("outreach_id") REFERENCES "outreach"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_email_account_id_fkey" FOREIGN KEY ("email_account_id") REFERENCES "email_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
