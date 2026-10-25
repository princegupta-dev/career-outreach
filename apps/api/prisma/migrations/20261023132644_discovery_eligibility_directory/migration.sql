-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "career_url" TEXT,
ADD COLUMN     "category" TEXT,
ADD COLUMN     "provenance" JSONB,
ADD COLUMN     "team_size" INTEGER;

-- AlterTable
ALTER TABLE "job_sources" ADD COLUMN     "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "last_success_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "eligibility" TEXT NOT NULL DEFAULT 'ELIGIBLE',
ADD COLUMN     "eligibility_flags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "directory_companies" (
    "id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "website" TEXT,
    "domain" TEXT,
    "team_size" INTEGER,
    "location" TEXT,
    "category" TEXT,
    "industries" JSONB,
    "career_url" TEXT,
    "ats" "JobProviderKind",
    "ats_slug" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "probed_at" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provenance" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "directory_companies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "directory_companies_status_probed_at_idx" ON "directory_companies"("status", "probed_at");

-- CreateIndex
CREATE UNIQUE INDEX "directory_companies_source_external_id_key" ON "directory_companies"("source", "external_id");
