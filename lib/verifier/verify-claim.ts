import { Prisma } from "@/app/generated/prisma/client";
import {
  AuditActor,
  CheckName,
  CheckStatus,
  ClaimState,
  DonationStatus,
  VerdictCode,
} from "@/app/generated/prisma/enums";
import { transitionClaim } from "@/lib/claims";
import { prisma } from "@/lib/db";
import { getAvailableBalance } from "@/lib/ledger";
import { confirmDonation, type OrderConfirmation } from "@/lib/paypal/orders";
import { findDuplicateClaimIds } from "@/lib/verifier/duplicates";
import { assessPurpose, readReceipt, type PurposeAssessment } from "@/lib/verifier/model";
import type { ExtractedReceipt, ReceiptReading } from "@/lib/verifier/reading";

export const MIN_CONFIDENCE = 0.8;

export type VerifierDeps = {
  readReceipt: (image: Uint8Array, mimeType: string) => Promise<ReceiptReading>;
  assessPurpose: (
    project: { title: string; purpose: string },
    receipt: ExtractedReceipt,
  ) => Promise<PurposeAssessment>;
  confirmDonation: (donation: {
    paypalOrderId: string;
    paypalCaptureId: string | null;
    amountMinor: number;
    currency: string;
  }) => Promise<OrderConfirmation>;
};

const realDeps: VerifierDeps = {
  readReceipt: (image, mimeType) => readReceipt(image, mimeType),
  assessPurpose: (project, receipt) => assessPurpose(project, receipt),
  confirmDonation,
};

type Evidence = Prisma.InputJsonValue;

const dateOnly = (date: Date) => date.toISOString().slice(0, 10);

// Runs one claim from SUBMITTED to APPROVED, REJECTED or ESCALATED and returns
// the verdict. It never pays: an APPROVED claim waits for executeReimbursement.
// Check rows are written as each one finishes, so the UI can show them live.
export async function verifyClaim(
  claimId: string,
  deps: VerifierDeps = realDeps,
): Promise<VerdictCode> {
  const claim = await prisma.claim.findUniqueOrThrow({
    where: { id: claimId },
    include: { project: true, receipt: true },
  });
  const { project, receipt: storedReceipt } = claim;
  if (!storedReceipt) throw new Error(`Claim ${claimId} has no receipt`);

  const runId = await prisma.$transaction(async (tx) => {
    await transitionClaim(tx, {
      claimId,
      from: ClaimState.SUBMITTED,
      to: ClaimState.VERIFYING,
      actor: AuditActor.SYSTEM,
    });
    const run = await tx.verificationRun.create({
      data: {
        claimId,
        checks: { create: Object.values(CheckName).map((name) => ({ name })) },
      },
    });
    return run.id;
  });

  const record = (name: CheckName, status: CheckStatus, evidence: Evidence) =>
    prisma.verificationCheck.update({
      where: { runId_name: { runId, name } },
      data: { status, evidence, completedAt: new Date() },
    });

  const finish = async (verdictCode: VerdictCode, note: string) => {
    await prisma.$transaction(async (tx) => {
      await tx.verificationCheck.updateMany({
        where: { runId, status: CheckStatus.PENDING },
        data: { status: CheckStatus.SKIPPED },
      });
      await tx.verificationRun.update({
        where: { id: runId },
        data: { verdictCode, finishedAt: new Date() },
      });
      await transitionClaim(tx, {
        claimId,
        from: ClaimState.VERIFYING,
        to: verdictCode.startsWith("REJECTED") ? ClaimState.REJECTED : ClaimState.ESCALATED,
        actor: AuditActor.AGENT,
        verdictCode,
        note,
      });
    });
    return verdictCode;
  };

  // The earlier balance check can be stale by now. The row lock makes concurrent
  // approvals on one project take turns, so they cannot spend the same money.
  const approve = async (amountMinor: number) => {
    const approved = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${project.id} FOR UPDATE`;
      const { availableMinor } = await getAvailableBalance(project.id, {
        db: tx,
        excludeClaimId: claimId,
      });
      if (amountMinor > availableMinor) {
        await tx.verificationCheck.update({
          where: { runId_name: { runId, name: CheckName.WITHIN_BALANCE } },
          data: {
            status: CheckStatus.FAILED,
            evidence: { amountMinor, availableMinor, stage: "final re-check" },
          },
        });
        return false;
      }
      await tx.verificationRun.update({
        where: { id: runId },
        data: { verdictCode: VerdictCode.APPROVED, finishedAt: new Date() },
      });
      await transitionClaim(tx, {
        claimId,
        from: ClaimState.VERIFYING,
        to: ClaimState.APPROVED,
        actor: AuditActor.AGENT,
        verdictCode: VerdictCode.APPROVED,
        note: "All checks passed",
      });
      return true;
    });
    if (approved) return VerdictCode.APPROVED;
    return finish(VerdictCode.REJECTED_OVER_BALANCE, "Balance changed during verification");
  };

  const runChecks = async (): Promise<VerdictCode> => {
    // Check 1: read the receipt.
    let reading: ReceiptReading;
    try {
      reading = await deps.readReceipt(storedReceipt.imageData, storedReceipt.mimeType);
    } catch (error) {
      await record(CheckName.RECEIPT_PARSED, CheckStatus.ERRORED, { error: errorName(error) });
      return finish(VerdictCode.ESCALATED_MODEL_ERROR, "Model could not read the receipt");
    }
    if (reading.outcome === "unreadable") {
      await record(CheckName.RECEIPT_PARSED, CheckStatus.FAILED, { readable: false });
      return finish(VerdictCode.ESCALATED_UNREADABLE_RECEIPT, "Receipt could not be read");
    }
    if (reading.outcome === "failed") {
      await record(CheckName.RECEIPT_PARSED, CheckStatus.FAILED, { reason: reading.reason });
      return finish(VerdictCode.ESCALATED_EXTRACTION_FAILED, reading.reason);
    }

    const receipt = reading.receipt;
    await prisma.$transaction([
      prisma.receipt.update({
        where: { id: storedReceipt.id },
        data: { extracted: receipt },
      }),
      prisma.claim.update({
        where: { id: claimId },
        data: { amountMinor: receipt.totalMinor },
      }),
    ]);

    if (receipt.currency !== project.currency) {
      const reason = `Receipt is in ${receipt.currency}, project is in ${project.currency}`;
      await record(CheckName.RECEIPT_PARSED, CheckStatus.FAILED, { reason });
      return finish(VerdictCode.ESCALATED_EXTRACTION_FAILED, reason);
    }
    // The total decides how much money moves, so a total that disagrees with its
    // own line items goes to a person, however confident the model says it is.
    const itemsTotalMinor = receipt.lineItems.reduce((sum, item) => sum + item.totalMinor, 0);
    const parsedEvidence = {
      confidence: receipt.confidence,
      totalMinor: receipt.totalMinor,
      itemsTotalMinor,
    };
    if (receipt.confidence < MIN_CONFIDENCE || itemsTotalMinor !== receipt.totalMinor) {
      await record(CheckName.RECEIPT_PARSED, CheckStatus.FAILED, parsedEvidence);
      return finish(VerdictCode.ESCALATED_LOW_CONFIDENCE, "Reading is not reliable enough");
    }
    await record(CheckName.RECEIPT_PARSED, CheckStatus.PASSED, parsedEvidence);

    // Checks 2, 3 and 5 need no model, so they all run before spending a model
    // call, and the page shows every problem at once.
    const startDate = dateOnly(project.startDate);
    const endDate = dateOnly(project.endDate);
    const inWindow = receipt.date >= startDate && receipt.date <= endDate;
    await record(
      CheckName.WITHIN_PROJECT_WINDOW,
      inWindow ? CheckStatus.PASSED : CheckStatus.FAILED,
      { purchaseDate: receipt.date, startDate, endDate },
    );

    const { availableMinor } = await getAvailableBalance(project.id, {
      excludeClaimId: claimId,
    });
    const withinBalance = receipt.totalMinor <= availableMinor;
    await record(
      CheckName.WITHIN_BALANCE,
      withinBalance ? CheckStatus.PASSED : CheckStatus.FAILED,
      { amountMinor: receipt.totalMinor, availableMinor },
    );

    const matchingClaims = await findDuplicateClaimIds(
      prisma,
      claimId,
      storedReceipt.sha256,
      receipt,
    );
    await record(
      CheckName.NOT_DUPLICATE,
      matchingClaims.length === 0 ? CheckStatus.PASSED : CheckStatus.FAILED,
      { matchingClaims },
    );

    if (matchingClaims.length > 0) {
      return finish(VerdictCode.REJECTED_DUPLICATE, "Receipt matches an earlier claim");
    }
    if (!inWindow) {
      return finish(VerdictCode.REJECTED_OUTSIDE_WINDOW, "Purchase is outside the project window");
    }
    if (!withinBalance) {
      return finish(VerdictCode.REJECTED_OVER_BALANCE, "Amount is more than the available balance");
    }

    // Check 4: does the purchase serve the project?
    let purpose: PurposeAssessment;
    try {
      purpose = await deps.assessPurpose(project, receipt);
    } catch (error) {
      await record(CheckName.ITEMS_SERVE_PURPOSE, CheckStatus.ERRORED, { error: errorName(error) });
      return finish(VerdictCode.ESCALATED_MODEL_ERROR, "Model could not assess the items");
    }
    await record(
      CheckName.ITEMS_SERVE_PURPOSE,
      purpose.serves ? CheckStatus.PASSED : CheckStatus.FAILED,
      { reason: purpose.reason },
    );
    if (!purpose.serves) {
      return finish(VerdictCode.ESCALATED_ITEM_MISMATCH, purpose.reason);
    }

    // Check 6: every donation in the pool must exist as a completed capture.
    const donations = await prisma.donation.findMany({
      where: { projectId: project.id, status: DonationStatus.CAPTURED },
      select: {
        id: true,
        paypalOrderId: true,
        paypalCaptureId: true,
        amountMinor: true,
        currency: true,
      },
    });
    let confirmations: OrderConfirmation[];
    try {
      confirmations = await Promise.all(donations.map((d) => deps.confirmDonation(d)));
    } catch (error) {
      await record(CheckName.POOL_CONFIRMED, CheckStatus.ERRORED, { error: errorName(error) });
      return finish(VerdictCode.ESCALATED_PAYPAL_ERROR, "PayPal could not confirm the pool");
    }
    const mismatches = confirmations.flatMap((confirmation, index) =>
      confirmation.confirmed
        ? []
        : [{ donationId: donations[index].id, reason: confirmation.reason }],
    );
    await record(
      CheckName.POOL_CONFIRMED,
      mismatches.length === 0 ? CheckStatus.PASSED : CheckStatus.FAILED,
      { confirmedDonations: donations.length - mismatches.length, mismatches },
    );
    if (mismatches.length > 0) {
      return finish(VerdictCode.ESCALATED_LEDGER_MISMATCH, "Ledger and PayPal disagree");
    }

    return approve(receipt.totalMinor);
  };

  try {
    return await runChecks();
  } catch (error) {
    // Nothing may strand a claim in VERIFYING. If the database itself is down
    // this throws too, and the claim stays visible for a person to find.
    return finish(VerdictCode.ESCALATED_MODEL_ERROR, `System error: ${errorName(error)}`);
  }
}

// Names only: provider messages can carry request details (rule 5).
const errorName = (error: unknown) => (error instanceof Error ? error.name : "UnknownError");
