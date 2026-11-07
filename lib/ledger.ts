import type { Prisma, PrismaClient } from "@/app/generated/prisma/client";
import { ClaimState, DonationStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/lib/db";

// Item statuses where the money did not leave, or has come back to the sender.
// Anything else on an ESCALATED claim stays reserved, including UNCLAIMED and
// ONHOLD, so a retry can never spend the same pesos twice.
const RELEASED_PAYOUT_ITEM_STATUSES = ["FAILED", "RETURNED", "REFUNDED", "REVERSED"];

export type ProjectBalance = {
  currency: string;
  capturedMinor: number;
  paidMinor: number;
  inFlightMinor: number;
  // Not clamped: a negative balance means something went wrong and must show.
  availableMinor: number;
};

type Options = {
  // Pass the transaction client so the balance is read inside the transaction.
  db?: PrismaClient | Prisma.TransactionClient;
  // Leave one claim out, so a claim being re-checked does not count against itself.
  excludeClaimId?: string;
};

// Captured donations minus paid and in-flight reimbursements.
export async function getAvailableBalance(
  projectId: string,
  { db = prisma, excludeClaimId }: Options = {},
): Promise<ProjectBalance> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { currency: true },
  });
  if (!project) throw new Error(`Project ${projectId} not found`);

  const [donations, claims] = await Promise.all([
    db.donation.findMany({
      where: { projectId, status: DonationStatus.CAPTURED },
      select: { amountMinor: true, currency: true },
    }),
    db.claim.findMany({
      where: {
        projectId,
        id: excludeClaimId ? { not: excludeClaimId } : undefined,
        OR: [
          { state: { in: [ClaimState.APPROVED, ClaimState.PAYING, ClaimState.PAID] } },
          {
            state: ClaimState.ESCALATED,
            payout: {
              OR: [
                { itemStatus: null },
                { itemStatus: { notIn: RELEASED_PAYOUT_ITEM_STATUSES } },
              ],
            },
          },
        ],
      },
      select: { state: true, amountMinor: true, currency: true },
    }),
  ]);

  // Summing two currencies would give a meaningless number, so fail loudly.
  for (const row of [...donations, ...claims]) {
    if (row.currency !== project.currency) {
      throw new Error(
        `Project ${projectId} is in ${project.currency} but has a ${row.currency} row`,
      );
    }
  }

  const capturedMinor = donations.reduce((sum, d) => sum + d.amountMinor, 0);
  let paidMinor = 0;
  let inFlightMinor = 0;
  for (const claim of claims) {
    if (claim.amountMinor === null) {
      throw new Error(`Project ${projectId} has a committed claim with no amount`);
    }
    if (claim.state === ClaimState.PAID) paidMinor += claim.amountMinor;
    else inFlightMinor += claim.amountMinor;
  }

  return {
    currency: project.currency,
    capturedMinor,
    paidMinor,
    inFlightMinor,
    availableMinor: capturedMinor - paidMinor - inFlightMinor,
  };
}
