import { DonationStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/lib/db";
import { getAvailableBalance } from "@/lib/ledger";
import { fromPayPalValue } from "@/lib/money";
import type { CheckoutCapture, CheckoutOrder } from "@/lib/paypal/checkout";

// PayPal keeps around 3.4% + PHP 15 per capture, so tiny gifts would mostly become fees.
export const MIN_DONATION_MINOR = 5_000;
export const MAX_DONATION_MINOR = 10_000_000;

const RECENT_DONATIONS = 5;
const MAX_DONOR_NAME_LENGTH = 40;

export type DonationProgress = {
  currency: string;
  raisedMinor: number;
  goalMinor: number;
  // Whole percent, and capped so the bar cannot overflow once the goal is passed.
  percent: number;
  donorCount: number;
  recent: { id: string; name: string; amountMinor: number }[];
};

export type RecordResult =
  | { outcome: "recorded" | "already-recorded"; projectId: string }
  | { outcome: "not-completed"; status: string }
  // Not one of this app's donation orders, or one that cannot count towards the project.
  | { outcome: "ignored"; reason: string };

// No Donation row exists until the capture completes, so what the order is for
// travels on the order itself. That also serves the webhook, which has no browser.
export function encodeCustomId(projectId: string, anonymous: boolean): string {
  return `${projectId}|${anonymous ? "anon" : "named"}`;
}

export function parseCustomId(customId: string | undefined) {
  const match = /^([a-z0-9]+)\|(anon|named)$/.exec(customId ?? "");
  return match ? { projectId: match[1], anonymous: match[2] === "anon" } : null;
}

// First name only. Surnames and emails never reach the database.
function donorFirstName(order: CheckoutOrder): string | null {
  const name = order.payer?.name?.given_name?.trim().replace(/\s+/g, " ");
  return name ? name.slice(0, MAX_DONOR_NAME_LENGTH) : null;
}

function findCapture(order: CheckoutOrder): CheckoutCapture | undefined {
  const captures = order.purchase_units?.flatMap((unit) => unit.payments?.captures ?? []) ?? [];
  return captures.find((capture) => capture.status === "COMPLETED") ?? captures[0];
}

// The only code that writes a Donation. The capture route and the webhook both
// end here, in either order and any number of times.
export async function recordCompletedDonation(order: CheckoutOrder): Promise<RecordResult> {
  const capture = findCapture(order);
  if (capture?.status !== "COMPLETED") {
    return { outcome: "not-completed", status: capture?.status ?? order.status };
  }

  const custom = parseCustomId(capture.custom_id ?? order.purchase_units?.[0]?.custom_id);
  if (!custom) return { outcome: "ignored", reason: "No donation details on the order" };

  const project = await prisma.project.findUnique({
    where: { id: custom.projectId },
    select: { id: true, currency: true },
  });
  if (!project) return { outcome: "ignored", reason: "Unknown project" };
  if (capture.amount.currency_code !== project.currency) {
    return { outcome: "ignored", reason: `Capture is in ${capture.amount.currency_code}` };
  }

  // ON CONFLICT DO NOTHING on the order and capture ids, so the capture route and
  // the webhook can race safely, and an existing row is never overwritten.
  const { count } = await prisma.donation.createMany({
    data: {
      projectId: project.id,
      paypalOrderId: order.id,
      paypalCaptureId: capture.id,
      amountMinor: fromPayPalValue(capture.amount.value),
      currency: project.currency,
      status: DonationStatus.CAPTURED,
      donorName: custom.anonymous ? null : donorFirstName(order),
      capturedAt: capture.create_time ? new Date(capture.create_time) : new Date(),
    },
    skipDuplicates: true,
  });
  return { outcome: count === 1 ? "recorded" : "already-recorded", projectId: project.id };
}

export async function getProjectProgress(projectId: string): Promise<DonationProgress> {
  const [project, balance, donorCount, recent] = await Promise.all([
    prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { goalMinor: true },
    }),
    getAvailableBalance(projectId),
    prisma.donation.count({ where: { projectId, status: DonationStatus.CAPTURED } }),
    prisma.donation.findMany({
      where: { projectId, status: DonationStatus.CAPTURED },
      orderBy: { capturedAt: "desc" },
      take: RECENT_DONATIONS,
      select: { id: true, donorName: true, amountMinor: true },
    }),
  ]);

  return {
    currency: balance.currency,
    raisedMinor: balance.capturedMinor,
    goalMinor: project.goalMinor,
    percent: Math.min(100, Math.floor((balance.capturedMinor * 100) / project.goalMinor)),
    donorCount,
    recent: recent.map((donation) => ({
      id: donation.id,
      name: donation.donorName ?? "Anonymous",
      amountMinor: donation.amountMinor,
    })),
  };
}
