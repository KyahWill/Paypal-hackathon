import type { Prisma } from "@/app/generated/prisma/client";
import {
  CheckName,
  type CheckStatus,
  type ClaimState,
  type VerdictCode,
} from "@/app/generated/prisma/enums";

export type Evidence = Prisma.InputJsonValue;

// The order the checks run in, which is also the order to show them.
export const CHECK_ORDER: CheckName[] = [
  CheckName.RECEIPT_PARSED,
  CheckName.WITHIN_PROJECT_WINDOW,
  CheckName.WITHIN_BALANCE,
  CheckName.NOT_DUPLICATE,
  CheckName.ITEMS_SERVE_PURPOSE,
  CheckName.POOL_CONFIRMED,
];

// Each event fires after its database write commits, so a page never shows
// something the database does not hold. Skipped checks have no evidence.
export type VerifierEvent =
  | { type: "run_started"; runId: string; checks: CheckName[] }
  | { type: "check_started"; runId: string; name: CheckName }
  | {
      type: "check_finished";
      runId: string;
      name: CheckName;
      status: CheckStatus;
      evidence?: Evidence;
    }
  | { type: "verdict"; runId: string; code: VerdictCode; state: ClaimState };

export type ProgressListener = (event: VerifierEvent) => void | Promise<void>;

// A closed browser tab must never change what happens to a claim.
export function safeListener(listener?: ProgressListener) {
  const report = (error: unknown) =>
    console.warn(`Verifier progress listener failed: ${error instanceof Error ? error.name : "UnknownError"}`);
  return (event: VerifierEvent) => {
    try {
      Promise.resolve(listener?.(event)).catch(report);
    } catch (error) {
      report(error);
    }
  };
}
