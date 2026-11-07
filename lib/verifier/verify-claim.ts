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
import { findDuplicateClaimIds } from "@/lib/verifier/duplicates";
import {
  CHECK_ORDER,
  safeListener,
  type Evidence,
  type ProgressListener,
} from "@/lib/verifier/events";
import { assessPurpose, readReceipt, type PurposeAssessment } from "@/lib/verifier/model";
import {
  confirmPool,
  ModelCallError,
  type PoolConfirmation,
  type PoolDonation,
} from "@/lib/verifier/pool-agent";
import type { ExtractedReceipt, ReceiptReading } from "@/lib/verifier/reading";

export const MIN_CONFIDENCE = 0.7;
export const MIN_PURPOSE_SCORE = 0.7;

export type VerifierDeps = {
  readReceipt: (image: Uint8Array, mimeType: string) => Promise<ReceiptReading>;
  assessPurpose: (
    project: { title: string; purpose: string },
    receipt: ExtractedReceipt,
  ) => Promise<PurposeAssessment>;
  confirmPool: (donations: PoolDonation[]) => Promise<PoolConfirmation>;
};

const realDeps: VerifierDeps = {
  readReceipt: (image, mimeType) => readReceipt(image, mimeType),
  assessPurpose: (project, receipt) => assessPurpose(project, receipt),
  confirmPool: (donations) => confirmPool(donations),
};

const dateOnly = (date: Date) => date.toISOString().slice(0, 10);

// Runs one claim from SUBMITTED to APPROVED, REJECTED or ESCALATED and returns
// the verdict. It never pays: an APPROVED claim waits for executeReimbursement.
// Check rows are written as each one finishes, and onProgress hears about each
// write, so the UI can show them live.
export async function verifyClaim(
  claimId: string,
  deps: VerifierDeps = realDeps,
  onProgress?: ProgressListener,
): Promise<VerdictCode> {
  const emit = safeListener(onProgress);
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
        checks: { create: CHECK_ORDER.map((name) => ({ name })) },
      },
    });
    return run.id;
  });
  emit({ type: "run_started", runId, checks: CHECK_ORDER });

  const start = (name: CheckName) => emit({ type: "check_started", runId, name });

  const record = async (name: CheckName, status: CheckStatus, evidence: Evidence) => {
    await prisma.verificationCheck.update({
      where: { runId_name: { runId, name } },
      data: { status, evidence, completedAt: new Date() },
    });
    emit({ type: "check_finished", runId, name, status, evidence });
  };

  const finish = async (verdictCode: VerdictCode, note: string) => {
    const state = verdictCode.startsWith("REJECTED") ? ClaimState.REJECTED : ClaimState.ESCALATED;
    const skipped = await prisma.$transaction(async (tx) => {
      const pending = await tx.verificationCheck.findMany({
        where: { runId, status: CheckStatus.PENDING },
        select: { name: true },
      });
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
        to: state,
        actor: AuditActor.AGENT,
        verdictCode,
        note,
      });
      return pending.map(({ name }) => name);
    });
    const remaining = CHECK_ORDER.filter((name) => skipped.includes(name));
    for (const name of remaining) {
      emit({ type: "check_finished", runId, name, status: CheckStatus.SKIPPED });
    }
    emit({ type: "verdict", runId, code: verdictCode, state });
    return verdictCode;
  };

  // The earlier balance check can be stale by now. The row lock makes concurrent
  // approvals on one project take turns, so they cannot spend the same money.
  const approve = async (amountMinor: number) => {
    const overBalance = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${project.id} FOR UPDATE`;
      const { availableMinor } = await getAvailableBalance(project.id, {
        db: tx,
        excludeClaimId: claimId,
      });
      if (amountMinor > availableMinor) {
        const evidence = { amountMinor, availableMinor, stage: "final re-check" };
        await tx.verificationCheck.update({
          where: { runId_name: { runId, name: CheckName.WITHIN_BALANCE } },
          data: { status: CheckStatus.FAILED, evidence },
        });
        return evidence;
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
      return null;
    });
    if (overBalance) {
      emit({
        type: "check_finished",
        runId,
        name: CheckName.WITHIN_BALANCE,
        status: CheckStatus.FAILED,
        evidence: overBalance,
      });
      return finish(VerdictCode.REJECTED_OVER_BALANCE, "Balance changed during verification");
    }
    emit({ type: "verdict", runId, code: VerdictCode.APPROVED, state: ClaimState.APPROVED });
    return VerdictCode.APPROVED;
  };

  const runChecks = async (): Promise<VerdictCode> => {
    // Check 1: read the receipt.
    start(CheckName.RECEIPT_PARSED);
    let reading: ReceiptReading;
    try {
      reading = await deps.readReceipt(storedReceipt.imageData, storedReceipt.mimeType);
    } catch (error) {
      await record(CheckName.RECEIPT_PARSED, CheckStatus.ERRORED, { error: errorName(error) });
      return finish(VerdictCode.ESCALATED_MODEL_ERROR, "Model could not read the receipt");
    }
    if (reading.outcome === "unreadable") {
      await record(CheckName.RECEIPT_PARSED, CheckStatus.FAILED, { unreadable: true });
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
    start(CheckName.WITHIN_PROJECT_WINDOW);
    const startDate = dateOnly(project.startDate);
    const endDate = dateOnly(project.endDate);
    const inWindow = receipt.date >= startDate && receipt.date <= endDate;
    await record(
      CheckName.WITHIN_PROJECT_WINDOW,
      inWindow ? CheckStatus.PASSED : CheckStatus.FAILED,
      { purchaseDate: receipt.date, startDate, endDate },
    );

    start(CheckName.WITHIN_BALANCE);
    const { availableMinor } = await getAvailableBalance(project.id, {
      excludeClaimId: claimId,
    });
    const withinBalance = receipt.totalMinor <= availableMinor;
    await record(
      CheckName.WITHIN_BALANCE,
      withinBalance ? CheckStatus.PASSED : CheckStatus.FAILED,
      { amountMinor: receipt.totalMinor, availableMinor },
    );

    start(CheckName.NOT_DUPLICATE);
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
    start(CheckName.ITEMS_SERVE_PURPOSE);
    let purpose: PurposeAssessment;
    try {
      purpose = await deps.assessPurpose(project, receipt);
    } catch (error) {
      await record(CheckName.ITEMS_SERVE_PURPOSE, CheckStatus.ERRORED, { error: errorName(error) });
      return finish(VerdictCode.ESCALATED_MODEL_ERROR, "Model could not assess the items");
    }
    const servesPurpose = purpose.score >= MIN_PURPOSE_SCORE;
    await record(
      CheckName.ITEMS_SERVE_PURPOSE,
      servesPurpose ? CheckStatus.PASSED : CheckStatus.FAILED,
      { score: purpose.score, rationale: purpose.rationale, threshold: MIN_PURPOSE_SCORE },
    );
    if (!servesPurpose) {
      return finish(VerdictCode.ESCALATED_ITEM_MISMATCH, purpose.rationale);
    }

    // Check 6: every donation in the pool must exist as a completed capture.
    start(CheckName.POOL_CONFIRMED);
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
    let pool: PoolConfirmation;
    try {
      pool = await deps.confirmPool(donations);
    } catch (error) {
      await record(CheckName.POOL_CONFIRMED, CheckStatus.ERRORED, { error: errorName(error) });
      if (error instanceof ModelCallError) {
        return finish(VerdictCode.ESCALATED_MODEL_ERROR, "Model could not finish the pool check");
      }
      return finish(VerdictCode.ESCALATED_PAYPAL_ERROR, "PayPal could not confirm the pool");
    }
    const mismatches = pool.results.flatMap(({ donationId, confirmation }) =>
      confirmation.confirmed ? [] : [{ donationId, reason: confirmation.reason }],
    );
    await record(
      CheckName.POOL_CONFIRMED,
      mismatches.length === 0 ? CheckStatus.PASSED : CheckStatus.FAILED,
      {
        confirmedDonations: pool.results.length - mismatches.length,
        mismatches,
        agentLookups: pool.agentLookups,
        codeLookups: pool.codeLookups,
      },
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
