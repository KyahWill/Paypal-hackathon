// Runs in the Render build, because Free services have no shell or pre-deploy
// step. Seeds an empty database and otherwise leaves it alone. See docs/deploy.md.
import "dotenv/config";
import { execSync } from "node:child_process";
import { prisma } from "@/lib/db";
import { seedAction } from "../seed/deploy-decision";

async function main() {
  const action = seedAction({
    projectCount: await prisma.project.count(),
    resetCommit: process.env.DEMO_RESET_COMMIT,
    deployCommit: process.env.RENDER_GIT_COMMIT,
  });
  await prisma.$disconnect();

  if (action === "keep") {
    console.log("Database already seeded, leaving it alone.");
    return;
  }
  console.log(action === "reset" ? "DEMO_RESET_COMMIT matches: wiping and reseeding." : "Empty database: seeding.");
  execSync("npx tsx prisma/seed.ts", { stdio: "inherit" });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
