// Files one demo receipt as a new claim and runs the real verifier on it.
//   npm run verify:receipt -- clean|overBalance|duplicate|unreadable
// Local databases only, because it adds claims. Set DATABASE_URL to leslie_dev.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClaim } from "@/lib/claims";
import { prisma } from "@/lib/db";
import { getAvailableBalance } from "@/lib/ledger";
import { verifyClaim } from "@/lib/verifier/verify-claim";
import { RECEIPTS } from "../seed/data";

async function main() {
  const key = process.argv[2] as keyof typeof RECEIPTS;
  const source = RECEIPTS[key];
  if (!source) throw new Error(`Use one of: ${Object.keys(RECEIPTS).join(", ")}`);

  const { hostname } = new URL(process.env.DATABASE_URL ?? "postgresql://missing");
  if (hostname !== "localhost") throw new Error("Refusing: DATABASE_URL must be local");

  const project = await prisma.project.findFirstOrThrow();
  const treasurer = await prisma.user.findFirstOrThrow({ where: { role: "TREASURER" } });
  const claim = await createClaim({
    projectId: project.id,
    submittedById: treasurer.id,
    image: readFileSync(join(process.cwd(), "seed/receipts", source.file)),
    mimeType: "image/png",
  });

  console.log(`Verdict: ${await verifyClaim(claim.id)}`);

  const run = await prisma.verificationRun.findFirstOrThrow({
    where: { claimId: claim.id },
    include: { checks: true },
  });
  for (const check of run.checks) {
    console.log(`${check.status.padEnd(8)} ${check.name} ${JSON.stringify(check.evidence ?? {})}`);
  }
  const { availableMinor, currency } = await getAvailableBalance(project.id);
  console.log(`Available: ${currency} ${(availableMinor / 100).toFixed(2)}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
