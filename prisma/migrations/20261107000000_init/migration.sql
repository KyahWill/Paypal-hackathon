-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('TREASURER', 'ADMIN');

-- CreateEnum
CREATE TYPE "DonationStatus" AS ENUM ('CREATED', 'CAPTURED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "ClaimState" AS ENUM ('SUBMITTED', 'VERIFYING', 'APPROVED', 'PAYING', 'PAID', 'REJECTED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "VerdictCode" AS ENUM ('APPROVED', 'REJECTED_OVER_BALANCE', 'REJECTED_OUTSIDE_WINDOW', 'REJECTED_DUPLICATE', 'ESCALATED_UNREADABLE_RECEIPT', 'ESCALATED_EXTRACTION_FAILED', 'ESCALATED_LOW_CONFIDENCE', 'ESCALATED_ITEM_MISMATCH', 'ESCALATED_LEDGER_MISMATCH', 'ESCALATED_MODEL_ERROR', 'ESCALATED_PAYPAL_ERROR');

-- CreateEnum
CREATE TYPE "CheckName" AS ENUM ('RECEIPT_PARSED', 'WITHIN_BALANCE', 'WITHIN_PROJECT_WINDOW', 'ITEMS_SERVE_PURPOSE', 'NOT_DUPLICATE', 'POOL_CONFIRMED');

-- CreateEnum
CREATE TYPE "CheckStatus" AS ENUM ('PENDING', 'PASSED', 'FAILED', 'ERRORED');

-- CreateEnum
CREATE TYPE "AuditActor" AS ENUM ('SYSTEM', 'AGENT', 'USER');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "charityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Charity" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "payoutEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Charity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "charityId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "goalMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Donation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "paypalOrderId" TEXT NOT NULL,
    "paypalCaptureId" TEXT,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "DonationStatus" NOT NULL DEFAULT 'CREATED',
    "donorName" TEXT,
    "capturedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Donation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Claim" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "submittedById" TEXT NOT NULL,
    "state" "ClaimState" NOT NULL DEFAULT 'SUBMITTED',
    "amountMinor" INTEGER,
    "currency" TEXT NOT NULL,
    "verdictCode" "VerdictCode",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Receipt" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "imageData" BYTEA NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "extracted" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationRun" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "verdictCode" "VerdictCode",
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "VerificationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationCheck" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "name" "CheckName" NOT NULL,
    "status" "CheckStatus" NOT NULL DEFAULT 'PENDING',
    "evidence" JSONB,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "VerificationCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "senderBatchId" TEXT NOT NULL,
    "paypalBatchId" TEXT,
    "paypalItemId" TEXT,
    "receiverEmail" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "batchStatus" TEXT,
    "itemStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "actor" "AuditActor" NOT NULL,
    "actorUserId" TEXT,
    "fromState" "ClaimState",
    "toState" "ClaimState" NOT NULL,
    "verdictCode" "VerdictCode",
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Project_charityId_idx" ON "Project"("charityId");

-- CreateIndex
CREATE UNIQUE INDEX "Donation_paypalOrderId_key" ON "Donation"("paypalOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Donation_paypalCaptureId_key" ON "Donation"("paypalCaptureId");

-- CreateIndex
CREATE INDEX "Donation_projectId_status_idx" ON "Donation"("projectId", "status");

-- CreateIndex
CREATE INDEX "Claim_projectId_state_idx" ON "Claim"("projectId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_claimId_key" ON "Receipt"("claimId");

-- CreateIndex
CREATE INDEX "Receipt_sha256_idx" ON "Receipt"("sha256");

-- CreateIndex
CREATE INDEX "VerificationRun_claimId_idx" ON "VerificationRun"("claimId");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationCheck_runId_name_key" ON "VerificationCheck"("runId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_claimId_key" ON "Payout"("claimId");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_senderBatchId_key" ON "Payout"("senderBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_paypalBatchId_key" ON "Payout"("paypalBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_paypalItemId_key" ON "Payout"("paypalItemId");

-- CreateIndex
CREATE INDEX "AuditLog_claimId_createdAt_idx" ON "AuditLog"("claimId", "createdAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_charityId_fkey" FOREIGN KEY ("charityId") REFERENCES "Charity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_charityId_fkey" FOREIGN KEY ("charityId") REFERENCES "Charity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Donation" ADD CONSTRAINT "Donation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationRun" ADD CONSTRAINT "VerificationRun_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationCheck" ADD CONSTRAINT "VerificationCheck_runId_fkey" FOREIGN KEY ("runId") REFERENCES "VerificationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

