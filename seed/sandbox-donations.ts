import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SANDBOX_DONATIONS_PATH = join(process.cwd(), "seed/sandbox-donations.json");

// One real sandbox order per entry in DONATIONS, matched by position.
// captureId is null until the buyer has approved and we have captured it.
export type SandboxDonation = {
  donorName: string;
  amountMinor: number;
  orderId: string;
  captureId: string | null;
};

export function readSandboxDonations(path = SANDBOX_DONATIONS_PATH): SandboxDonation[] {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")) as SandboxDonation[];
}

// The seed must never present an id PayPal has not confirmed, or verifier
// check 6 would escalate every claim.
export function requireCapturedDonations<T extends { donorName: string; amountMinor: number }>(
  donations: T[],
  records: SandboxDonation[],
) {
  return donations.map((donation, index) => {
    const record = records[index];
    if (
      !record?.captureId ||
      record.amountMinor !== donation.amountMinor ||
      record.donorName !== donation.donorName
    ) {
      throw new Error(
        `Donation ${index + 1} (${donation.donorName}) has no matching sandbox capture. ` +
          "Run: npm run donations:capture",
      );
    }
    return { ...donation, orderId: record.orderId, captureId: record.captureId };
  });
}
