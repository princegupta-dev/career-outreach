-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JobProviderKind" ADD VALUE 'REMOTIVE';
ALTER TYPE "JobProviderKind" ADD VALUE 'HIMALAYAS';
ALTER TYPE "JobProviderKind" ADD VALUE 'JOBICY';
ALTER TYPE "JobProviderKind" ADD VALUE 'ARBEITNOW';
ALTER TYPE "JobProviderKind" ADD VALUE 'REMOTEOK';
ALTER TYPE "JobProviderKind" ADD VALUE 'HN_HIRING';
ALTER TYPE "JobProviderKind" ADD VALUE 'WWR';

-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "auto_prepared_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "job_sources" ADD COLUMN     "is_default" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "last_stats" JSONB;

-- AlterTable
ALTER TABLE "outreach" ADD COLUMN     "draft_message_id" TEXT,
ADD COLUMN     "draft_sync_error" TEXT,
ADD COLUMN     "draft_synced_at" TIMESTAMP(3),
ADD COLUMN     "gmail_draft_id" TEXT;

-- AlterTable
ALTER TABLE "resume_versions" ADD COLUMN     "compile_log" TEXT,
ADD COLUMN     "compile_status" TEXT,
ADD COLUMN     "latex" TEXT,
ADD COLUMN     "pdf" BYTEA;

-- AlterTable
ALTER TABLE "resumes" ADD COLUMN     "compile_log" TEXT,
ADD COLUMN     "latex_assets" JSONB,
ADD COLUMN     "latex_engine" TEXT,
ADD COLUMN     "latex_hash" TEXT,
ADD COLUMN     "latex_source" TEXT,
ADD COLUMN     "pdf" BYTEA;

-- CreateTable
CREATE TABLE "discovery_runs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "trigger" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "stats" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "discovery_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interviews" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "stage" TEXT NOT NULL,
    "scheduled_at" TIMESTAMP(3),
    "outcome" TEXT NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "discovery_runs_user_id_started_at_idx" ON "discovery_runs"("user_id", "started_at");

-- CreateIndex
CREATE INDEX "interviews_user_id_scheduled_at_idx" ON "interviews"("user_id", "scheduled_at");

-- AddForeignKey
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
