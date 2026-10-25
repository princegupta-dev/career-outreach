-- CreateEnum
CREATE TYPE "ResumeSourceKind" AS ENUM ('LEGACY', 'UPLOAD', 'EDIT');

-- CreateEnum
CREATE TYPE "ResumeSourceStatus" AS ENUM ('PENDING_REVIEW', 'CONFIRMED', 'DISCARDED');

-- AlterTable
ALTER TABLE "resume_versions" ADD COLUMN     "source_version_id" UUID;

-- AlterTable
ALTER TABLE "resumes" ADD COLUMN     "active_source_version_id" UUID;

-- CreateTable
CREATE TABLE "resume_source_versions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "resume_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "kind" "ResumeSourceKind" NOT NULL,
    "status" "ResumeSourceStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "label" TEXT NOT NULL,
    "job_id" UUID,
    "parent_id" UUID,
    "original_name" TEXT,
    "mime_type" TEXT,
    "size_bytes" INTEGER,
    "file_sha256" TEXT,
    "original_file" BYTEA,
    "extracted_text" TEXT,
    "data" JSONB NOT NULL,
    "latex_source" TEXT,
    "content_hash" TEXT NOT NULL,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "confidence" DOUBLE PRECISION,
    "confirmed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resume_source_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "resume_source_versions_resume_id_status_idx" ON "resume_source_versions"("resume_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "resume_source_versions_user_id_version_no_key" ON "resume_source_versions"("user_id", "version_no");

-- AddForeignKey
ALTER TABLE "resume_source_versions" ADD CONSTRAINT "resume_source_versions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resume_source_versions" ADD CONSTRAINT "resume_source_versions_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "resumes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
