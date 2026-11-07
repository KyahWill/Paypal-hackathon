import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ClaimState, DonationStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/lib/db";
import { truncateAllTables } from "@/lib/db-reset";
import { getAvailableBalance } from "@/lib/ledger";

let projectId: string;
let userId: string;
let nextId = 0;

async function createProject() {
  const charity = await prisma.charity.create({
    data: { name: "Test Charity", payoutEmail: "charity@example.test" },
  });
  const project = await prisma.project.create({
    data: {
      charityId: charity.id,
      slug: randomUUID(),
      story: "Testing",
      title: "Test Project",
      purpose: "Testing",
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-12-31"),
      goalMinor: 1_000_000,
      currency: "PHP",
    },
  });
  return { charity, project };
}

function donate(
  amountMinor: number,
  status: DonationStatus = DonationStatus.CAPTURED,
  overrides: { projectId?: string; currency?: string } = {},
) {
  nextId += 1;
  return prisma.donation.create({
    data: {
      projectId,
      paypalOrderId: `ORDER-${nextId}`,
      amountMinor,
      currency: "PHP",
      status,
      ...overrides,
    },
  });
}

function claim(
  amountMinor: number | null,
  state: ClaimState,
  overrides: { projectId?: string; currency?: string } = {},
) {
  return prisma.claim.create({
    data: {
      projectId,
      submittedById: userId,
      amountMinor,
      state,
      currency: "PHP",
      ...overrides,
    },
  });
}

function payout(claimId: string, itemStatus: string | null) {
  return prisma.payout.create({
    data: {
      claimId,
      senderBatchId: `batch-${claimId}`,
      receiverEmail: "charity@example.test",
      amountMinor: 1000,
      currency: "PHP",
      itemStatus,
    },
  });
}

beforeEach(async () => {
  await truncateAllTables(prisma);
  const { charity, project } = await createProject();
  projectId = project.id;
  const user = await prisma.user.create({
    data: {
      email: "treasurer@example.test",
      passwordHash: "x",
      name: "Treasurer",
      role: "TREASURER",
      charityId: charity.id,
    },
  });
  userId = user.id;
});

afterAll(() => prisma.$disconnect());

describe("getAvailableBalance", () => {
  it("is zero for a project with no money in or out", async () => {
    expect(await getAvailableBalance(projectId)).toEqual({
      currency: "PHP",
      capturedMinor: 0,
      paidMinor: 0,
      inFlightMinor: 0,
      availableMinor: 0,
    });
  });

  it("counts only captured donations", async () => {
    await donate(10_000);
    await donate(5_050);
    await donate(99_900, DonationStatus.CREATED);
    await donate(88_800, DonationStatus.REFUNDED);

    const balance = await getAvailableBalance(projectId);
    expect(balance.capturedMinor).toBe(15_050);
    expect(balance.availableMinor).toBe(15_050);
  });

  it("subtracts paid claims and reports them apart from in-flight ones", async () => {
    await donate(100_000);
    await claim(10_000, ClaimState.PAID);
    await claim(2_000, ClaimState.APPROVED);
    await claim(3_000, ClaimState.PAYING);

    expect(await getAvailableBalance(projectId)).toMatchObject({
      paidMinor: 10_000,
      inFlightMinor: 5_000,
      availableMinor: 85_000,
    });
  });

  it.each([ClaimState.SUBMITTED, ClaimState.VERIFYING, ClaimState.REJECTED])(
    "does not reserve money for a %s claim",
    async (state) => {
      await donate(100_000);
      await claim(10_000, state);
      expect((await getAvailableBalance(projectId)).availableMinor).toBe(100_000);
    },
  );

  it("does not reserve money for a claim escalated before any payout", async () => {
    await donate(100_000);
    await claim(10_000, ClaimState.ESCALATED);
    expect((await getAvailableBalance(projectId)).availableMinor).toBe(100_000);
  });

  it("ignores an unreadable claim with no amount yet", async () => {
    await donate(100_000);
    await claim(null, ClaimState.ESCALATED);
    expect((await getAvailableBalance(projectId)).availableMinor).toBe(100_000);
  });

  it.each(["UNCLAIMED", "ONHOLD", "PENDING", "SOME_NEW_STATUS", null])(
    "keeps money reserved when an escalated payout is %s",
    async (itemStatus) => {
      await donate(100_000);
      const c = await claim(10_000, ClaimState.ESCALATED);
      await payout(c.id, itemStatus);

      const balance = await getAvailableBalance(projectId);
      expect(balance.inFlightMinor).toBe(10_000);
      expect(balance.availableMinor).toBe(90_000);
    },
  );

  it.each(["FAILED", "RETURNED", "REFUNDED", "REVERSED"])(
    "releases money when an escalated payout is %s",
    async (itemStatus) => {
      await donate(100_000);
      const c = await claim(10_000, ClaimState.ESCALATED);
      await payout(c.id, itemStatus);
      expect((await getAvailableBalance(projectId)).availableMinor).toBe(100_000);
    },
  );

  it("keeps projects separate", async () => {
    const other = await createProject();
    await donate(100_000);
    await donate(50_000, DonationStatus.CAPTURED, { projectId: other.project.id });
    await claim(7_000, ClaimState.PAID, { projectId: other.project.id });
    expect((await getAvailableBalance(projectId)).availableMinor).toBe(100_000);
  });

  it("leaves out the excluded claim", async () => {
    await donate(100_000);
    const c = await claim(100_000, ClaimState.APPROVED);
    await claim(1_000, ClaimState.PAYING);

    expect((await getAvailableBalance(projectId)).availableMinor).toBe(-1_000);
    expect(
      (await getAvailableBalance(projectId, { excludeClaimId: c.id })).availableMinor,
    ).toBe(99_000);
  });

  it("does not clamp an overdrawn pool to zero", async () => {
    await donate(1_000);
    await claim(5_000, ClaimState.PAID);
    expect((await getAvailableBalance(projectId)).availableMinor).toBe(-4_000);
  });

  it("reads uncommitted rows when given a transaction client", async () => {
    await donate(100_000);
    await prisma.$transaction(async (tx) => {
      await tx.claim.create({
        data: {
          projectId,
          submittedById: userId,
          amountMinor: 40_000,
          state: ClaimState.APPROVED,
          currency: "PHP",
        },
      });
      const balance = await getAvailableBalance(projectId, { db: tx });
      expect(balance.availableMinor).toBe(60_000);
    });
  });

  it("throws rather than mix currencies", async () => {
    await donate(1_000);
    await donate(1_000, DonationStatus.CAPTURED, { currency: "USD" });
    await expect(getAvailableBalance(projectId)).rejects.toThrow(/USD/);
  });

  it("throws for a claim in another currency", async () => {
    await donate(1_000);
    await claim(500, ClaimState.PAID, { currency: "USD" });
    await expect(getAvailableBalance(projectId)).rejects.toThrow(/USD/);
  });

  it("throws for a committed claim with no amount", async () => {
    await claim(null, ClaimState.APPROVED);
    await expect(getAvailableBalance(projectId)).rejects.toThrow(/no amount/);
  });

  it("throws for an unknown project", async () => {
    await expect(getAvailableBalance("nope")).rejects.toThrow(/not found/);
  });
});

describe("AuditLog", () => {
  async function auditRow() {
    const c = await claim(1_000, ClaimState.SUBMITTED);
    return prisma.auditLog.create({
      data: { claimId: c.id, actor: "SYSTEM", toState: ClaimState.SUBMITTED },
    });
  }

  it("rejects updates", async () => {
    const row = await auditRow();
    await expect(
      prisma.auditLog.update({ where: { id: row.id }, data: { note: "changed" } }),
    ).rejects.toThrow(/append-only/);
  });

  it("rejects deletes", async () => {
    const row = await auditRow();
    await expect(prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(
      /append-only/,
    );
  });
});
