-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ApplicationStatus" ADD VALUE 'PREPARING';
ALTER TYPE "ApplicationStatus" ADD VALUE 'READY_FOR_REVIEW';
ALTER TYPE "ApplicationStatus" ADD VALUE 'APPROVED';
ALTER TYPE "ApplicationStatus" ADD VALUE 'APPLIED';
ALTER TYPE "ApplicationStatus" ADD VALUE 'SKIPPED';

-- CreateTable
CREATE TABLE "preparation_workflows" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "mode" TEXT,
    "steps" JSONB NOT NULL DEFAULT '{}',
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "heartbeat_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "preparation_workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preparation_events" (
    "id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "step" TEXT,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preparation_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "preparation_workflows_application_id_key" ON "preparation_workflows"("application_id");

-- CreateIndex
CREATE INDEX "preparation_workflows_user_id_status_idx" ON "preparation_workflows"("user_id", "status");

-- CreateIndex
CREATE INDEX "preparation_events_workflow_id_created_at_idx" ON "preparation_events"("workflow_id", "created_at");

-- AddForeignKey
ALTER TABLE "preparation_workflows" ADD CONSTRAINT "preparation_workflows_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preparation_events" ADD CONSTRAINT "preparation_events_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "preparation_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
