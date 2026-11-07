import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaimState } from "@/app/generated/prisma/enums";
import { createClaim } from "@/lib/claims";
import { prisma } from "@/lib/db";
import { truncateAllTables } from "@/lib/db-reset";
import { getAvailableBalance } from "@/lib/ledger";
import type { ExtractedReceipt } from "@/lib/verifier/reading";
import { verifyClaim, type VerifierDeps } from "@/lib/verifier/verify-claim";
import {
  DONATIONS,
  PROJECT,
  RECEIPTS,
  receiptTotalMinor,
  type ReceiptData,
} from "@/seed/data";

let projectId: string;
let treasurerId: string;

const reading = (source: ReceiptData, overrides: Partial<ExtractedReceipt> = {}) => ({
  outcome: "read" as const,
  receipt: {
    vendor: source.store,
    date: source.date,
    lineItems: source.items.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unitPriceMinor: item.unitPriceMinor,
      totalMinor: item.quantity * item.unitPriceMinor,
    })),
    totalMinor: receiptTotalMinor(source),
    currency: "PHP",
    confidence: 0.95,
    ...overrides,
  },
});

function fakeDeps(overrides: Partial<VerifierDeps> = {}) {
  return {
    readReceipt: vi.fn<VerifierDeps["readReceipt"]>(async () => reading(RECEIPTS.clean)),
    assessPurpose: vi.fn<VerifierDeps["assessPurpose"]>(async () => ({
      serves: true,
      reason: "School supplies for pupils.",
    })),
    confirmDonation: vi.fn<VerifierDeps["confirmDonation"]>(async () => ({ confirmed: true })),
    ...overrides,
  };
}

let imageCounter = 0;
const uniqueImage = () => Buffer.from(`image-${(imageCounter += 1)}`);

const newClaim = (image: Buffer = uniqueImage()) =>
  createClaim({ projectId, submittedById: treasurerId, image, mimeType: "image/png" });

async function checksOf(claimId: string) {
  const run = await prisma.verificationRun.findFirstOrThrow({
    where: { claimId },
    include: { checks: true },
  });
  return Object.fromEntries(run.checks.map((check) => [check.name, check.status]));
}

const claimRow = (id: string) => prisma.claim.findUniqueOrThrow({ where: { id } });

// The seeded story, with the past claim's receipt already on file.
const paidImage = Buffer.from("paid-receipt-image");

beforeEach(async () => {
  await truncateAllTables(prisma);
  const charity = await prisma.charity.create({
    data: { name: "Test Charity", payoutEmail: "charity@example.test" },
  });
  const project = await prisma.project.create({
    data: {
      charityId: charity.id,
      slug: randomUUID(),
      story: "Testing",
      title: PROJECT.title,
      purpose: PROJECT.purpose,
      startDate: new Date(PROJECT.startDate),
      endDate: new Date(PROJECT.endDate),
      goalMinor: PROJECT.goalMinor,
      currency: "PHP",
    },
  });
  projectId = project.id;
  const treasurer = await prisma.user.create({
    data: {
      email: "t@example.test",
      passwordHash: "x",
      name: "Treasurer",
      role: "TREASURER",
      charityId: charity.id,
    },
  });
  treasurerId = treasurer.id;
  await prisma.donation.createMany({
    data: DONATIONS.map((donation, index) => ({
      projectId,
      paypalOrderId: `ORDER-${index}`,
      paypalCaptureId: `CAPTURE-${index}`,
      amountMinor: donation.amountMinor,
      currency: "PHP",
      status: "CAPTURED" as const,
    })),
  });
  await prisma.claim.create({
    data: {
      projectId,
      submittedById: treasurerId,
      state: ClaimState.PAID,
      amountMinor: receiptTotalMinor(RECEIPTS.duplicate),
      currency: "PHP",
      verdictCode: "APPROVED",
      receipt: {
        create: {
          imageData: new Uint8Array(paidImage),
          mimeType: "image/png",
          sha256: createHash("sha256").update(paidImage).digest("hex"),
          extracted: reading(RECEIPTS.duplicate).receipt,
        },
      },
    },
  });
});

afterAll(() => prisma.$disconnect());

describe("the four demo receipts", () => {
  it("approves the clean receipt and does not pay it", async () => {
    const claim = await newClaim();
    const deps = fakeDeps();

    expect(await verifyClaim(claim.id, deps)).toBe("APPROVED");

    const row = await claimRow(claim.id);
    expect(row.state).toBe(ClaimState.APPROVED);
    expect(row.amountMinor).toBe(receiptTotalMinor(RECEIPTS.clean));
    expect(Object.values(await checksOf(claim.id))).toEqual(Array(6).fill("PASSED"));
    expect(deps.confirmDonation).toHaveBeenCalledTimes(DONATIONS.length);
    expect(await prisma.payout.count({ where: { claimId: claim.id } })).toBe(0);
  });

  it("rejects the over-balance receipt without spending model or PayPal calls", async () => {
    const claim = await newClaim();
    const deps = fakeDeps({ readReceipt: async () => reading(RECEIPTS.overBalance) });

    expect(await verifyClaim(claim.id, deps)).toBe("REJECTED_OVER_BALANCE");

    expect(await checksOf(claim.id)).toMatchObject({
      WITHIN_BALANCE: "FAILED",
      ITEMS_SERVE_PURPOSE: "SKIPPED",
      POOL_CONFIRMED: "SKIPPED",
    });
    expect(deps.assessPurpose).not.toHaveBeenCalled();
    expect(deps.confirmDonation).not.toHaveBeenCalled();
    expect((await claimRow(claim.id)).state).toBe(ClaimState.REJECTED);
  });

  it("rejects the duplicate receipt by image hash", async () => {
    const claim = await newClaim(paidImage);
    const deps = fakeDeps({ readReceipt: async () => reading(RECEIPTS.duplicate) });
    expect(await verifyClaim(claim.id, deps)).toBe("REJECTED_DUPLICATE");
  });

  it("escalates the unreadable receipt, with no amount", async () => {
    const claim = await newClaim();
    const deps = fakeDeps({ readReceipt: async () => ({ outcome: "unreadable" }) });

    expect(await verifyClaim(claim.id, deps)).toBe("ESCALATED_UNREADABLE_RECEIPT");

    const row = await claimRow(claim.id);
    expect(row.state).toBe(ClaimState.ESCALATED);
    expect(row.amountMinor).toBeNull();
  });
});

describe("duplicates", () => {
  it("catches a different photo of the same purchase", async () => {
    const claim = await newClaim();
    const deps = fakeDeps({
      readReceipt: async () =>
        reading(RECEIPTS.duplicate, { vendor: "KAIBIGAN  paper & pen center" }),
    });
    expect(await verifyClaim(claim.id, deps)).toBe("REJECTED_DUPLICATE");
  });

  it("allows the same date and total from another store", async () => {
    const claim = await newClaim();
    const deps = fakeDeps({
      readReceipt: async () => reading(RECEIPTS.duplicate, { vendor: "Another Store" }),
    });
    expect(await verifyClaim(claim.id, deps)).toBe("APPROVED");
  });

  it("lets a charity resubmit a receipt after a rejection", async () => {
    const image = uniqueImage();
    const over = fakeDeps({ readReceipt: async () => reading(RECEIPTS.overBalance) });
    const first = await newClaim(image);
    expect(await verifyClaim(first.id, over)).toBe("REJECTED_OVER_BALANCE");

    await prisma.donation.create({
      data: {
        projectId,
        paypalOrderId: "ORDER-LARGE",
        paypalCaptureId: "CAPTURE-LARGE",
        amountMinor: 1_000_000,
        currency: "PHP",
        status: "CAPTURED",
      },
    });
    const second = await newClaim(image);
    expect(await verifyClaim(second.id, over)).toBe("APPROVED");
  });

  it("does not match a claim against itself", async () => {
    const claim = await newClaim();
    expect(await verifyClaim(claim.id, fakeDeps())).toBe("APPROVED");
    const { evidence } = await prisma.verificationCheck.findFirstOrThrow({
      where: { name: "NOT_DUPLICATE", run: { claimId: claim.id } },
    });
    expect(evidence).toEqual({ matchingClaims: [] });
  });
});

describe("the project window", () => {
  it.each(["2026-07-31", "2027-04-01"])("rejects a purchase on %s", async (date) => {
    const claim = await newClaim();
    const deps = fakeDeps({ readReceipt: async () => reading(RECEIPTS.clean, { date }) });
    expect(await verifyClaim(claim.id, deps)).toBe("REJECTED_OUTSIDE_WINDOW");
  });

  it.each([PROJECT.startDate, PROJECT.endDate])("accepts a purchase on %s", async (date) => {
    const claim = await newClaim();
    const deps = fakeDeps({ readReceipt: async () => reading(RECEIPTS.clean, { date }) });
    expect(await verifyClaim(claim.id, deps)).toBe("APPROVED");
  });
});

describe("the balance", () => {
  const exactly = (totalMinor: number) => ({
    lineItems: [{ description: "Notebooks", quantity: 1, unitPriceMinor: totalMinor, totalMinor }],
    totalMinor,
  });

  it("allows a claim for exactly the available balance", async () => {
    const claim = await newClaim();
    const deps = fakeDeps({
      readReceipt: async () => reading(RECEIPTS.clean, exactly(1_826_200)),
    });
    expect(await verifyClaim(claim.id, deps)).toBe("APPROVED");
  });

  it("rejects one centavo more", async () => {
    const claim = await newClaim();
    const deps = fakeDeps({
      readReceipt: async () => reading(RECEIPTS.clean, exactly(1_826_201)),
    });
    expect(await verifyClaim(claim.id, deps)).toBe("REJECTED_OVER_BALANCE");
  });

  it("lets only one of two racing claims spend the same money", async () => {
    // Holds both claims until each has passed the early balance check, so they
    // really do overlap and only the final locked re-check can stop the second.
    let arrived = 0;
    let release = () => {};
    const bothArrived = new Promise<void>((resolve) => (release = resolve));
    const racing = (date: string) =>
      fakeDeps({
        readReceipt: async () =>
          reading(RECEIPTS.clean, { vendor: `Store ${date}`, date, ...exactly(1_200_000) }),
        assessPurpose: async () => {
          arrived += 1;
          if (arrived === 2) release();
          await bothArrived;
          return { serves: true, reason: "School supplies." };
        },
      });
    const [first, second] = [await newClaim(), await newClaim()];

    const verdicts = await Promise.all([
      verifyClaim(first.id, racing("2026-10-01")),
      verifyClaim(second.id, racing("2026-10-02")),
    ]);

    expect(verdicts.sort()).toEqual(["APPROVED", "REJECTED_OVER_BALANCE"]);
    const { availableMinor } = await getAvailableBalance(projectId);
    expect(availableMinor).toBe(1_826_200 - 1_200_000);
  });
});

describe("escalations", () => {
  const cases: [string, Partial<VerifierDeps>, string][] = [
    [
      "a reading that failed validation",
      { readReceipt: async () => ({ outcome: "failed", reason: "Missing total" }) },
      "ESCALATED_EXTRACTION_FAILED",
    ],
    [
      "a receipt in another currency",
      { readReceipt: async () => reading(RECEIPTS.clean, { currency: "USD" }) },
      "ESCALATED_EXTRACTION_FAILED",
    ],
    [
      "low confidence",
      { readReceipt: async () => reading(RECEIPTS.clean, { confidence: 0.79 }) },
      "ESCALATED_LOW_CONFIDENCE",
    ],
    [
      "a total that disagrees with its line items",
      { readReceipt: async () => reading(RECEIPTS.clean, { totalMinor: 391_600 }) },
      "ESCALATED_LOW_CONFIDENCE",
    ],
    [
      "items that do not serve the project",
      { assessPurpose: async () => ({ serves: false, reason: "Karaoke machine." }) },
      "ESCALATED_ITEM_MISMATCH",
    ],
    [
      "a donation PayPal does not confirm",
      { confirmDonation: async () => ({ confirmed: false, reason: "Capture is REFUNDED" }) },
      "ESCALATED_LEDGER_MISMATCH",
    ],
    [
      "a read failure from the model",
      {
        readReceipt: async () => {
          throw new Error("key=secret");
        },
      },
      "ESCALATED_MODEL_ERROR",
    ],
    [
      "a purpose failure from the model",
      {
        assessPurpose: async () => {
          throw new Error("key=secret");
        },
      },
      "ESCALATED_MODEL_ERROR",
    ],
    [
      "a PayPal failure",
      {
        confirmDonation: async () => {
          throw new Error("key=secret");
        },
      },
      "ESCALATED_PAYPAL_ERROR",
    ],
  ];

  it.each(cases)("escalates %s", async (_, overrides, verdict) => {
    const claim = await newClaim();
    expect(await verifyClaim(claim.id, fakeDeps(overrides))).toBe(verdict);
    expect((await claimRow(claim.id)).state).toBe(ClaimState.ESCALATED);
  });

  it("accepts a confidence exactly at the limit", async () => {
    const claim = await newClaim();
    const deps = fakeDeps({ readReceipt: async () => reading(RECEIPTS.clean, { confidence: 0.8 }) });
    expect(await verifyClaim(claim.id, deps)).toBe("APPROVED");
  });

  it("keeps provider error messages out of the evidence and audit log", async () => {
    const claim = await newClaim();
    await verifyClaim(
      claim.id,
      fakeDeps({
        readReceipt: async () => {
          throw new Error("key=secret");
        },
      }),
    );
    const checks = await prisma.verificationCheck.findMany({ where: { run: { claimId: claim.id } } });
    const audit = await prisma.auditLog.findMany({ where: { claimId: claim.id } });
    expect(JSON.stringify([checks, audit])).not.toContain("secret");
  });
});

describe("the claim record", () => {
  it("writes an audit row for every state change", async () => {
    const claim = await newClaim();
    await verifyClaim(claim.id, fakeDeps());
    const rows = await prisma.auditLog.findMany({
      where: { claimId: claim.id },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((row) => row.toState)).toEqual(["SUBMITTED", "VERIFYING", "APPROVED"]);
    expect(rows[2]).toMatchObject({ actor: "AGENT", verdictCode: "APPROVED" });
  });

  it("stores the reading on the receipt", async () => {
    const claim = await newClaim();
    await verifyClaim(claim.id, fakeDeps());
    const receipt = await prisma.receipt.findUniqueOrThrow({ where: { claimId: claim.id } });
    expect(receipt.extracted).toMatchObject({ vendor: RECEIPTS.clean.store, date: RECEIPTS.clean.date });
  });

  it("will not verify a claim twice", async () => {
    const claim = await newClaim();
    await verifyClaim(claim.id, fakeDeps());
    await expect(verifyClaim(claim.id, fakeDeps())).rejects.toThrow(/not in state SUBMITTED/);
  });

  it("closes the run with its verdict", async () => {
    const claim = await newClaim();
    await verifyClaim(claim.id, fakeDeps());
    const run = await prisma.verificationRun.findFirstOrThrow({ where: { claimId: claim.id } });
    expect(run.verdictCode).toBe("APPROVED");
    expect(run.finishedAt).not.toBeNull();
  });
});
