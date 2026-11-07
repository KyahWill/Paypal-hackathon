import os from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": import.meta.dirname } },
  test: {
    // Tests truncate tables, so they get their own database. See tests/global-setup.ts.
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        `postgresql://${os.userInfo().username}@localhost:5432/leslie_test`,
    },
    globalSetup: "tests/global-setup.ts",
    fileParallelism: false,
  },
});
