// Wipes the database in DATABASE_URL and rebuilds the demo. Run with `npm run db:reset`.
import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hashPassword } from "@/lib/auth/password";
import { prisma } from "@/lib/db";
import { truncateAllTables } from "@/lib/db-reset";
import { getAvailableBalance } from "@/lib/ledger";
import { senderBatchIdForClaim } from "@/lib/paypal/payouts";
import {
  CHARITY,
  DONATIONS,
  PROJECT,
  RECEIPTS,
  receiptTotalMinor,
} from "../seed/data";
import { readSandboxDonations, requireCapturedDonations } from "../seed/sandbox-donations";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const at = (iso: string) => new Date(iso);

async function main() {
  const currency = requireEnv("CURRENCY");
  // The receipts are printed in pesos, so seeding any other currency would lie.
  if (currency !== "PHP") throw new Error(`Seed data is in PHP, but CURRENCY is ${currency}`);

  const adminEmail = requireEnv("SEED_ADMIN_EMAIL");
  const adminPassword = requireEnv("SEED_ADMIN_PASSWORD");
  const treasurerEmail = requireEnv("SEED_TREASURER_EMAIL");
  const treasurerPassword = requireEnv("SEED_TREASURER_PASSWORD");
  const payoutEmail = requireEnv("PAYPAL_CHARITY_RECEIVER_EMAIL");
  // Checked before the wipe, so a missing capture leaves the database untouched.
  const donations = requireCapturedDonations(DONATIONS, readSandboxDonations());

  await truncateAllTables(prisma);

  const charity = await prisma.charity.create({ data: { name: CHARITY.name, payoutEmail } });

  await prisma.user.create({
    data: {
      email: adminEmail,
      passwordHash: await hashPassword(adminPassword),
      name: "Platform Admin",
      role: "ADMIN",
    },
  });
  const treasurer = await prisma.user.create({
    data: {
      email: treasurerEmail,
      passwordHash: await hashPassword(treasurerPassword),
      name: "Bea Manalastas",
      role: "TREASURER",
      charityId: charity.id,
    },
  });

  const project = await prisma.project.create({
    data: {
      charityId: charity.id,
      slug: PROJECT.slug,
      title: PROJECT.title,
      story: PROJECT.story,
      purpose: PROJECT.purpose,
      startDate: at(PROJECT.startDate),
      endDate: at(PROJECT.endDate),
      goalMinor: PROJECT.goalMinor,
      currency,
    },
  });

  // Real sandbox ids, so verifier check 6 can confirm them. capturedAt is the
  // story date for the demo, not PayPal's capture time.
  await prisma.donation.createMany({
    data: donations.map((donation) => ({
      projectId: project.id,
      paypalOrderId: donation.orderId,
      paypalCaptureId: donation.captureId,
      amountMinor: donation.amountMinor,
      currency,
      status: "CAPTURED" as const,
      donorName: donation.donorName,
      capturedAt: at(donation.capturedAt),
      createdAt: at(donation.capturedAt),
    })),
  });

  await seedPaidClaim({ projectId: project.id, treasurerId: treasurer.id, currency, payoutEmail });

  const balance = await getAvailableBalance(project.id);
  console.log(
    `Seeded "${project.title}": ${DONATIONS.length} donations, 1 paid claim, ` +
      `${balance.currency} ${(balance.availableMinor / 100).toFixed(2)} available.`,
  );
}

async function seedPaidClaim(args: {
  projectId: string;
  treasurerId: string;
  currency: string;
  payoutEmail: string;
}) {
  const { projectId, treasurerId, currency, payoutEmail } = args;
  const source = RECEIPTS.duplicate;
  const amountMinor = receiptTotalMinor(source);
  const imageData = readFileSync(join(process.cwd(), "seed/receipts", source.file));

  const submittedAt = at("2026-09-20T03:10:00Z");
  const decidedAt = at("2026-09-20T03:11:12Z");
  const paidAt = at("2026-09-20T03:11:45Z");

  // cuid, never a fixed id: PayPal remembers sender_batch_id across demo resets,
  // so a claim id must not repeat.
  const claim = await prisma.claim.create({
    data: {
      projectId,
      submittedById: treasurerId,
      state: "PAID",
      amountMinor,
      currency,
      verdictCode: "APPROVED",
      createdAt: submittedAt,
      receipt: {
        create: {
          imageData,
          mimeType: "image/png",
          sha256: createHash("sha256").update(imageData).digest("hex"),
          extracted: {
            vendor: source.store,
            date: source.date,
            lineItems: source.items.map((item) => ({
              ...item,
              totalMinor: item.quantity * item.unitPriceMinor,
            })),
            totalMinor: amountMinor,
            currency,
            confidence: 0.97,
          },
          createdAt: submittedAt,
        },
      },
      verificationRuns: {
        create: {
          verdictCode: "APPROVED",
          startedAt: submittedAt,
          finishedAt: decidedAt,
          checks: {
            create: [
              {
                name: "RECEIPT_PARSED",
                status: "PASSED",
                evidence: { confidence: 0.97 },
                completedAt: decidedAt,
              },
              {
                name: "WITHIN_BALANCE",
                status: "PASSED",
                evidence: { amountMinor, availableMinor: 2_000_000 },
                completedAt: decidedAt,
              },
              {
                name: "WITHIN_PROJECT_WINDOW",
                status: "PASSED",
                evidence: {
                  purchaseDate: source.date,
                  startDate: PROJECT.startDate,
                  endDate: PROJECT.endDate,
                },
                completedAt: decidedAt,
              },
              {
                name: "ITEMS_SERVE_PURPOSE",
                status: "PASSED",
                evidence: { reason: "Notebooks, pens and paper for pupils match the project." },
                completedAt: decidedAt,
              },
              {
                name: "NOT_DUPLICATE",
                status: "PASSED",
                evidence: { matchingClaims: [] },
                completedAt: decidedAt,
              },
              {
                name: "POOL_CONFIRMED",
                status: "PASSED",
                evidence: { confirmedDonations: 5 },
                completedAt: decidedAt,
              },
            ],
          },
        },
      },
    },
  });

  await prisma.payout.create({
    data: {
      claimId: claim.id,
      senderBatchId: senderBatchIdForClaim(claim.id),
      paypalBatchId: "SEED-BATCH-1",
      paypalItemId: "SEED-ITEM-1",
      receiverEmail: payoutEmail,
      amountMinor,
      currency,
      batchStatus: "SUCCESS",
      itemStatus: "SUCCESS",
      createdAt: decidedAt,
    },
  });

  const history = [
    { actor: "USER", from: null, to: "SUBMITTED", time: submittedAt, note: "Claim filed in chat" },
    { actor: "SYSTEM", from: "SUBMITTED", to: "VERIFYING", time: submittedAt, note: null },
    { actor: "AGENT", from: "VERIFYING", to: "APPROVED", time: decidedAt, note: "All checks passed" },
    { actor: "SYSTEM", from: "APPROVED", to: "PAYING", time: decidedAt, note: null },
    { actor: "SYSTEM", from: "PAYING", to: "PAID", time: paidAt, note: "Payout item SUCCESS" },
  ] as const;

  await prisma.auditLog.createMany({
    data: history.map((entry) => ({
      claimId: claim.id,
      actor: entry.actor,
      actorUserId: entry.actor === "USER" ? treasurerId : null,
      fromState: entry.from,
      toState: entry.to,
      verdictCode: entry.to === "APPROVED" ? ("APPROVED" as const) : null,
      note: entry.note,
      createdAt: entry.time,
    })),
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
