import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ClaimState } from "@/app/generated/prisma/enums";
import { createClaim } from "@/lib/claims";
import { prisma } from "@/lib/db";
import { truncateAllTables } from "@/lib/db-reset";
import { toPayPalValue } from "@/lib/money";
import { assessPurpose, readReceipt } from "@/lib/verifier/model";
import { confirmPool } from "@/lib/verifier/pool-agent";
import type { ExtractedReceipt, RawReceiptReading } from "@/lib/verifier/reading";
import { verifyClaim, type VerifierDeps } from "@/lib/verifier/verify-claim";
import { DONATIONS, PROJECT, RECEIPTS, receiptTotalMinor, type ReceiptData } from "@/seed/data";

// The four real images, through the real model and PayPal code, with only the
// two network edges replaced. The model's answers are scripted per image, so
// this proves the pipeline. It says nothing about how well Gemini reads them:
// that is what `npm run verify:receipt -- all` is for.

type Generate = ConstructorParameters<typeof MockLanguageModelV4>[0] extends infer T
  ? T extends { doGenerate?: infer G }
    ? G
    : never
  : never;

type PromptPart = { type: string; data?: unknown; text?: string };
type PromptMessage = { role: string; content: string | PromptPart[] };
type CallOptions = { prompt: PromptMessage[]; tools?: unknown[] };

const imageOf = (source: ReceiptData) => readFileSync(join(process.cwd(), "seed/receipts", source.file));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const asPrinted = (source: ReceiptData): RawReceiptReading => ({
  unreadable: false,
  vendor: source.store,
  date: source.date,
  lineItems: source.items.map(({ description, quantity, unitPriceMinor }) => ({
    description,
    quantity,
    unitPrice: unitPriceMinor / 100,
    lineTotal: (quantity * unitPriceMinor) / 100,
  })),
  total: receiptTotalMinor(source) / 100,
  currency: "PHP",
  confidence: 0.95,
});

const blurred: RawReceiptReading = {
  unreadable: true,
  vendor: null,
  date: null,
  lineItems: [],
  total: null,
  currency: null,
  confidence: 0.1,
};

const scriptedReadings = new Map<string, RawReceiptReading>([
  [sha256(imageOf(RECEIPTS.clean)), asPrinted(RECEIPTS.clean)],
  [sha256(imageOf(RECEIPTS.overBalance)), asPrinted(RECEIPTS.overBalance)],
  [sha256(imageOf(RECEIPTS.duplicate)), asPrinted(RECEIPTS.duplicate)],
  [sha256(imageOf(RECEIPTS.unreadable)), blurred],
]);

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const text = (reply: string) => ({
  content: [{ type: "text", text: reply }],
  finishReason: { unified: "stop", raw: "stop" },
  usage,
  warnings: [],
});

const textOf = (message: PromptMessage) =>
  typeof message.content === "string"
    ? message.content
    : message.content.map((part) => part.text ?? "").join("");

// Behaves like Gemini for each of the three kinds of call the verifier makes.
const fakeGemini = () => {
  const calls = { read: 0, purpose: 0, pool: 0 };
  const model = new MockLanguageModelV4({
    doGenerate: (async ({ prompt, tools }: CallOptions) => {
      const parts = prompt.flatMap((m) => (typeof m.content === "string" ? [] : m.content));
      const file = parts.find((part) => part.type === "file");
      if (file) {
        calls.read += 1;
        const reading = scriptedReadings.get(sha256(imageBytes(file.data)));
        if (!reading) throw new Error("Not one of the seed receipts");
        return text(JSON.stringify(reading));
      }
      if (tools?.length) {
        if (prompt.some((m) => m.role === "tool")) return text("All confirmed.");
        calls.pool += 1;
        const user = prompt.find((m) => m.role === "user")!;
        const { orderIds } = JSON.parse(textOf(user)) as { orderIds: string[] };
        return {
          content: orderIds.map((id) => ({
            type: "tool-call",
            toolCallId: id,
            toolName: "get_order",
            input: JSON.stringify({ id }),
          })),
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage,
          warnings: [],
        };
      }
      calls.purpose += 1;
      return text(JSON.stringify({ score: 0.95, rationale: "These are school supplies." }));
    }) as unknown as Generate,
  });
  return { model, calls };
};

function imageBytes(data: unknown): Uint8Array {
  const wrapped = data as { type?: string; data?: Uint8Array };
  return wrapped.type === "data" ? wrapped.data! : (data as Uint8Array);
}

// PayPal as the ledger expects it: every seeded order is a completed capture.
const fakePayPal = async (orderId: string) => {
  const index = Number(orderId.replace("ORDER-", ""));
  return JSON.stringify({
    status: "COMPLETED",
    purchase_units: [
      {
        payments: {
          captures: [
            {
              id: `CAPTURE-${index}`,
              status: "COMPLETED",
              amount: { currency_code: "PHP", value: toPayPalValue(DONATIONS[index].amountMinor) },
            },
          ],
        },
      },
    ],
  });
};

let projectId: string;
let treasurerId: string;

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

  // As in the seed: the duplicate's image is already on file as a paid claim.
  const paidImage = imageOf(RECEIPTS.duplicate);
  const extracted: ExtractedReceipt = {
    vendor: RECEIPTS.duplicate.store,
    date: RECEIPTS.duplicate.date,
    lineItems: [],
    totalMinor: receiptTotalMinor(RECEIPTS.duplicate),
    currency: "PHP",
    confidence: 0.95,
  };
  await prisma.claim.create({
    data: {
      projectId,
      submittedById: treasurerId,
      state: ClaimState.PAID,
      amountMinor: extracted.totalMinor,
      currency: "PHP",
      verdictCode: "APPROVED",
      receipt: {
        create: {
          imageData: new Uint8Array(paidImage),
          mimeType: "image/png",
          sha256: sha256(paidImage),
          extracted,
        },
      },
    },
  });
});

afterAll(() => prisma.$disconnect());

const realPipeline = () => {
  const { model, calls } = fakeGemini();
  const deps: VerifierDeps = {
    readReceipt: (image, mimeType) => readReceipt(image, mimeType, model),
    assessPurpose: (project, receipt) => assessPurpose(project, receipt, model),
    confirmPool: (donations) => confirmPool(donations, { model, fetchOrder: fakePayPal }),
  };
  return { deps, calls };
};

const file = (source: ReceiptData) =>
  createClaim({
    projectId,
    submittedById: treasurerId,
    image: imageOf(source),
    mimeType: "image/png",
  });

async function checksOf(claimId: string) {
  const { checks } = await prisma.verificationRun.findFirstOrThrow({
    where: { claimId },
    include: { checks: true },
  });
  return Object.fromEntries(checks.map((check) => [check.name, check.status]));
}

const claimRow = (id: string) => prisma.claim.findUniqueOrThrow({ where: { id } });

describe("the four seed receipts", () => {
  it("clean-valid.png is approved, with the agent confirming every donation", async () => {
    const claim = await file(RECEIPTS.clean);
    const { deps, calls } = realPipeline();

    expect(await verifyClaim(claim.id, deps)).toBe("APPROVED");

    expect(await claimRow(claim.id)).toMatchObject({
      state: ClaimState.APPROVED,
      amountMinor: 391_500,
    });
    expect(new Set(Object.values(await checksOf(claim.id)))).toEqual(new Set(["PASSED"]));
    const { evidence } = await prisma.verificationCheck.findFirstOrThrow({
      where: { name: "POOL_CONFIRMED", run: { claimId: claim.id } },
    });
    expect(evidence).toMatchObject({
      confirmedDonations: 8,
      mismatches: [],
      agentLookups: 8,
      codeLookups: 0,
    });
    expect(calls).toEqual({ read: 1, purpose: 1, pool: 1 });
  });

  it("over-balance.png is rejected before any further model or PayPal call", async () => {
    const claim = await file(RECEIPTS.overBalance);
    const { deps, calls } = realPipeline();

    expect(await verifyClaim(claim.id, deps)).toBe("REJECTED_OVER_BALANCE");

    expect(await claimRow(claim.id)).toMatchObject({
      state: ClaimState.REJECTED,
      amountMinor: 2_216_250,
    });
    expect(await checksOf(claim.id)).toMatchObject({
      RECEIPT_PARSED: "PASSED",
      WITHIN_BALANCE: "FAILED",
      ITEMS_SERVE_PURPOSE: "SKIPPED",
      POOL_CONFIRMED: "SKIPPED",
    });
    expect(calls).toEqual({ read: 1, purpose: 0, pool: 0 });
  });

  it("duplicate-of-paid.png is rejected against the paid claim", async () => {
    const claim = await file(RECEIPTS.duplicate);
    const { deps, calls } = realPipeline();
    const paid = await prisma.claim.findFirstOrThrow({ where: { state: ClaimState.PAID } });

    expect(await verifyClaim(claim.id, deps)).toBe("REJECTED_DUPLICATE");

    expect((await claimRow(claim.id)).state).toBe(ClaimState.REJECTED);
    const { evidence } = await prisma.verificationCheck.findFirstOrThrow({
      where: { name: "NOT_DUPLICATE", run: { claimId: claim.id } },
    });
    expect(evidence).toEqual({ matchingClaims: [paid.id] });
    expect(calls).toEqual({ read: 1, purpose: 0, pool: 0 });
  });

  it("blurry-unreadable.png is escalated with no amount", async () => {
    const claim = await file(RECEIPTS.unreadable);
    const { deps, calls } = realPipeline();

    expect(await verifyClaim(claim.id, deps)).toBe("ESCALATED_UNREADABLE_RECEIPT");

    expect(await claimRow(claim.id)).toMatchObject({
      state: ClaimState.ESCALATED,
      amountMinor: null,
    });
    expect(await checksOf(claim.id)).toMatchObject({
      RECEIPT_PARSED: "FAILED",
      WITHIN_BALANCE: "SKIPPED",
    });
    expect(calls).toEqual({ read: 1, purpose: 0, pool: 0 });
  });
});
