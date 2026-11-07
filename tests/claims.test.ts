import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ClaimState } from "@/app/generated/prisma/enums";
import { createClaim, transitionClaim } from "@/lib/claims";
import { prisma } from "@/lib/db";
import { truncateAllTables } from "@/lib/db-reset";

let claimId: string;

beforeEach(async () => {
  await truncateAllTables(prisma);
  const charity = await prisma.charity.create({
    data: { name: "Test", payoutEmail: "c@example.test" },
  });
  const project = await prisma.project.create({
    data: {
      charityId: charity.id,
      title: "T",
      purpose: "P",
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-12-31"),
      goalMinor: 1,
      currency: "PHP",
    },
  });
  const user = await prisma.user.create({
    data: { email: "t@example.test", passwordHash: "x", name: "T", role: "TREASURER" },
  });
  const claim = await createClaim({
    projectId: project.id,
    submittedById: user.id,
    image: Buffer.from("abc"),
    mimeType: "image/png",
  });
  claimId = claim.id;
});

afterAll(() => prisma.$disconnect());

const move = (from: ClaimState, to: ClaimState) =>
  prisma.$transaction((tx) =>
    transitionClaim(tx, { claimId, from, to, actor: "SYSTEM" }),
  );

describe("createClaim", () => {
  it("stores the receipt hash and audits the submission", async () => {
    const receipt = await prisma.receipt.findUniqueOrThrow({ where: { claimId } });
    expect(receipt.sha256).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const audit = await prisma.auditLog.findMany({ where: { claimId } });
    expect(audit).toMatchObject([{ fromState: null, toState: "SUBMITTED", actor: "USER" }]);
  });
});

describe("transitionClaim", () => {
  it("rolls the state back if the transaction fails", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await transitionClaim(tx, {
          claimId,
          from: ClaimState.SUBMITTED,
          to: ClaimState.VERIFYING,
          actor: "SYSTEM",
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const claim = await prisma.claim.findUniqueOrThrow({ where: { id: claimId } });
    expect(claim.state).toBe(ClaimState.SUBMITTED);
    expect(await prisma.auditLog.count({ where: { claimId } })).toBe(1);
  });

  it.each([
    [ClaimState.SUBMITTED, ClaimState.APPROVED],
    [ClaimState.VERIFYING, ClaimState.PAID],
    [ClaimState.APPROVED, ClaimState.PAID],
    [ClaimState.PAID, ClaimState.PAYING],
    [ClaimState.REJECTED, ClaimState.APPROVED],
    [ClaimState.ESCALATED, ClaimState.PAYING],
  ])("refuses %s -> %s", async (from, to) => {
    await expect(move(from, to)).rejects.toThrow(/not allowed/);
  });

  it("refuses a move from a state the claim is not in", async () => {
    await expect(move(ClaimState.VERIFYING, ClaimState.APPROVED)).rejects.toThrow(/not in state/);
  });

  it("lets only one of two racing moves win", async () => {
    const results = await Promise.allSettled([
      move(ClaimState.SUBMITTED, ClaimState.VERIFYING),
      move(ClaimState.SUBMITTED, ClaimState.VERIFYING),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { claimId } })).toBe(2);
  });
});
