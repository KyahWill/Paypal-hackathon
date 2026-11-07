import type { Prisma } from "@/app/generated/prisma/client";
import { ClaimState } from "@/app/generated/prisma/enums";
import type { ExtractedReceipt } from "@/lib/verifier/reading";

export const normaliseVendor = (vendor: string) =>
  vendor.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Rejected claims do not count, or a charity could never resubmit after a rejection.
export async function findDuplicateClaimIds(
  db: Prisma.TransactionClient,
  claimId: string,
  sha256: string,
  receipt: ExtractedReceipt,
): Promise<string[]> {
  const candidates = await db.receipt.findMany({
    where: {
      claimId: { not: claimId },
      claim: { state: { not: ClaimState.REJECTED } },
      OR: [
        { sha256 },
        {
          AND: [
            { extracted: { path: ["date"], equals: receipt.date } },
            { extracted: { path: ["totalMinor"], equals: receipt.totalMinor } },
          ],
        },
      ],
    },
    select: { claimId: true, sha256: true, extracted: true },
  });

  const vendor = normaliseVendor(receipt.vendor);
  return candidates
    .filter((candidate) => {
      if (candidate.sha256 === sha256) return true;
      const other = candidate.extracted as { vendor?: string } | null;
      return normaliseVendor(other?.vendor ?? "") === vendor;
    })
    .map((candidate) => candidate.claimId);
}
