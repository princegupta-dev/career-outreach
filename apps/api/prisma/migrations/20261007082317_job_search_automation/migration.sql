-- CreateEnum
CREATE TYPE "EmailVerificationStatus" AS ENUM ('UNKNOWN', 'PUBLICLY_LISTED', 'VERIFIED', 'INVALID', 'BOUNCED');

-- CreateEnum
CREATE TYPE "ContactSourceType" AS ENUM ('JOB_POSTING', 'CAREERS_PAGE', 'CONTACT_PAGE', 'COMPANY_WEBSITE', 'YC_PAGE', 'DATA_PROVIDER', 'MANUAL');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ApplicationStatus" ADD VALUE 'APPLIED';
ALTER TYPE "ApplicationStatus" ADD VALUE 'SKIPPED';

-- AlterEnum
ALTER TYPE "EmailEventType" ADD VALUE 'DRY_RUN';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JobProviderKind" ADD VALUE 'WORKABLE';
ALTER TYPE "JobProviderKind" ADD VALUE 'RECRUITEE';
ALTER TYPE "JobProviderKind" ADD VALUE 'YC_JOBS';
ALTER TYPE "JobProviderKind" ADD VALUE 'CAREER_PAGE';
ALTER TYPE "JobProviderKind" ADD VALUE 'WEB_SEARCH';

-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "applied_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "discovered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "source_type" "ContactSourceType" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "verification_status" "EmailVerificationStatus" NOT NULL DEFAULT 'UNKNOWN';

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "application_url" TEXT,
ADD COLUMN     "canonical_url" TEXT,
ADD COLUMN     "dedupe_key" TEXT,
ADD COLUMN     "experience_required" TEXT,
ADD COLUMN     "source_url" TEXT;

-- CreateIndex
CREATE INDEX "jobs_user_id_dedupe_key_idx" ON "jobs"("user_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "jobs_user_id_canonical_url_idx" ON "jobs"("user_id", "canonical_url");

-- CreateIndex
CREATE INDEX "jobs_user_id_posted_at_idx" ON "jobs"("user_id", "posted_at");

-- ─── Backfill ────────────────────────────────────────────────────────────────
-- Contacts: record where each address came from and whether it may be emailed.
-- Only addresses that were published by the company (job posting / its own website)
-- become PUBLICLY_LISTED. Data-provider rows need a public source page; manual rows
-- stay UNKNOWN until the user records where the address is published.
UPDATE "contacts" SET "discovered_at" = "created_at";

UPDATE "contacts" SET "source_type" = CASE
  WHEN "source" = 'job_posting' THEN 'JOB_POSTING'::"ContactSourceType"
  WHEN "source" = 'company_website' AND "source_url" ~* '/(careers?|jobs)(/|$)' THEN 'CAREERS_PAGE'::"ContactSourceType"
  WHEN "source" = 'company_website' AND "source_url" ~* '/contact(/|$)' THEN 'CONTACT_PAGE'::"ContactSourceType"
  WHEN "source" = 'company_website' THEN 'COMPANY_WEBSITE'::"ContactSourceType"
  WHEN "source" = 'hunter' THEN 'DATA_PROVIDER'::"ContactSourceType"
  ELSE 'MANUAL'::"ContactSourceType"
END;

UPDATE "contacts" SET "verification_status" = 'PUBLICLY_LISTED'::"EmailVerificationStatus"
WHERE "email" IS NOT NULL
  AND (
    "source" IN ('job_posting', 'company_website')
    OR ("source" = 'hunter' AND "source_url" IS NOT NULL)
  );

-- Bounced addresses are already on the suppression list.
UPDATE "contacts" c SET "verification_status" = 'BOUNCED'::"EmailVerificationStatus"
FROM "suppressions" s
WHERE s."user_id" = c."user_id" AND s."value" = c."email_normalized" AND s."reason" ILIKE '%bounce%';

-- Jobs: the listing URL is both where it was found and where to apply until a provider says otherwise.
UPDATE "jobs" SET "source_url" = "url", "application_url" = "url" WHERE "url" IS NOT NULL;
