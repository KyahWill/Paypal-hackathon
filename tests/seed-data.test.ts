import { describe, expect, it } from "vitest";
import {
  DONATIONS,
  PROJECT,
  RECEIPTS,
  receiptTotalMinor,
  receiptVatMinor,
} from "@/seed/data";

// The sandbox sender account holds PHP 5,000.00 (docs/spike.md).
const SANDBOX_SENDER_BALANCE_MINOR = 500_000;

const captured = DONATIONS.reduce((sum, d) => sum + d.amountMinor, 0);
const available = captured - receiptTotalMinor(RECEIPTS.duplicate);

describe("demo receipts", () => {
  it("leaves the clean receipt payable from the pool and the sandbox", () => {
    const total = receiptTotalMinor(RECEIPTS.clean);
    expect(total).toBeLessThanOrEqual(available);
    expect(total).toBeLessThan(SANDBOX_SENDER_BALANCE_MINOR);
  });

  it("keeps the over-balance receipt over, before and after the clean claim", () => {
    expect(receiptTotalMinor(RECEIPTS.overBalance)).toBeGreaterThan(available);
  });

  it.each(Object.entries(RECEIPTS))("%s is dated inside the project window", (_, receipt) => {
    expect(receipt.date >= PROJECT.startDate && receipt.date <= PROJECT.endDate).toBe(true);
  });

  it.each(Object.entries(RECEIPTS))("%s has cash covering the total", (_, receipt) => {
    expect(receipt.cashMinor).toBeGreaterThanOrEqual(receiptTotalMinor(receipt));
  });

  it("computes VAT as the 12% inside the total", () => {
    expect(receiptVatMinor(RECEIPTS.clean)).toBe(41_946);
  });
});
