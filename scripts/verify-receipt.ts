// Files demo receipts as new claims and runs the real verifier on them.
//   npm run verify:receipt -- all|clean|overBalance|duplicate|unreadable
// Local databases only, because it adds claims. Set DATABASE_URL to leslie_dev.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClaim } from "@/lib/claims";
import { prisma } from "@/lib/db";
import { getAvailableBalance } from "@/lib/ledger";
import type { VerifierEvent } from "@/lib/verifier/events";
import { verifyClaim } from "@/lib/verifier/verify-claim";
import { RECEIPTS } from "../seed/data";

type ReceiptKey = keyof typeof RECEIPTS;

// Keep in step with docs/demo.md.
const EXPECTED: Record<ReceiptKey, string> = {
  clean: "APPROVED",
  overBalance: "REJECTED_OVER_BALANCE",
  duplicate: "REJECTED_DUPLICATE",
  unreadable: "ESCALATED_UNREADABLE_RECEIPT",
};

function printProgress(event: VerifierEvent) {
  if (event.type !== "check_finished") return;
  console.log(`${event.status.padEnd(8)} ${event.name} ${JSON.stringify(event.evidence ?? {})}`);
}

async function main() {
  const name = process.argv[2];
  const keys = Object.keys(EXPECTED) as ReceiptKey[];
  const chosen = name === "all" ? keys : keys.filter((key) => key === name);
  if (chosen.length === 0) throw new Error(`Use all, or one of: ${keys.join(", ")}`);

  const { hostname } = new URL(process.env.DATABASE_URL ?? "postgresql://missing");
  if (hostname !== "localhost") throw new Error("Refusing: DATABASE_URL must be local");

  const project = await prisma.project.findFirstOrThrow();
  const treasurer = await prisma.user.findFirstOrThrow({ where: { role: "TREASURER" } });

  for (const key of chosen) {
    console.log(`\n${RECEIPTS[key].file}`);
    const claim = await createClaim({
      projectId: project.id,
      submittedById: treasurer.id,
      image: readFileSync(join(process.cwd(), "seed/receipts", RECEIPTS[key].file)),
      mimeType: "image/png",
    });
    const verdict = await verifyClaim(claim.id, undefined, printProgress);
    const matches = verdict === EXPECTED[key];
    console.log(`Verdict: ${verdict} (${matches ? "as expected" : `expected ${EXPECTED[key]}`})`);
    if (!matches) process.exitCode = 1;
  }

  const { availableMinor, currency } = await getAvailableBalance(project.id);
  console.log(`\nAvailable: ${currency} ${(availableMinor / 100).toFixed(2)}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
