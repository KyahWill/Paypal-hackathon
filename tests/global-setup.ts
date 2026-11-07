import { execSync } from "node:child_process";
import type { TestProject } from "vitest/node";

export default function setup(project: TestProject) {
  const url = project.config.env.DATABASE_URL!;
  // This suite truncates every table, so it must never reach a real database.
  if (!new URL(url).pathname.endsWith("_test")) {
    throw new Error("Refusing to run tests: database name must end in _test");
  }
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
}
