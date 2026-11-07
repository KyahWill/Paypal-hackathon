import { describe, expect, it } from "vitest";
import { seedAction } from "@/seed/deploy-decision";

describe("seedAction", () => {
  it("seeds an empty database", () => {
    expect(seedAction({ projectCount: 0 })).toBe("first-seed");
  });

  it("leaves a seeded database alone", () => {
    expect(seedAction({ projectCount: 1, deployCommit: "abc" })).toBe("keep");
  });

  it("resets when the commit matches", () => {
    expect(seedAction({ projectCount: 1, resetCommit: "abc", deployCommit: "abc" })).toBe("reset");
  });

  it("does not reset when a stale value is left behind", () => {
    expect(seedAction({ projectCount: 1, resetCommit: "abc", deployCommit: "def" })).toBe("keep");
  });

  it("does not reset outside Render, where there is no deploy commit", () => {
    expect(seedAction({ projectCount: 1, resetCommit: "abc" })).toBe("keep");
  });
});
