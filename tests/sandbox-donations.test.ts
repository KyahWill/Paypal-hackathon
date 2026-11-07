import { describe, expect, it } from "vitest";
import { requireCapturedDonations } from "@/seed/sandbox-donations";

const donation = { donorName: "Ate Joy", amountMinor: 75_000 };
const captured = { ...donation, orderId: "ORDER1", captureId: "CAPTURE1" };

describe("requireCapturedDonations", () => {
  it("joins a donation to its real PayPal ids", () => {
    expect(requireCapturedDonations([donation], [captured])).toEqual([
      { ...donation, orderId: "ORDER1", captureId: "CAPTURE1" },
    ]);
  });

  it("refuses a donation with no record", () => {
    expect(() => requireCapturedDonations([donation], [])).toThrow(/donations:capture/);
  });

  it("refuses an order that was never captured", () => {
    expect(() =>
      requireCapturedDonations([donation], [{ ...captured, captureId: null }]),
    ).toThrow(/donations:capture/);
  });

  it("refuses a capture for a different amount", () => {
    expect(() =>
      requireCapturedDonations([donation], [{ ...captured, amountMinor: 1 }]),
    ).toThrow(/donations:capture/);
  });
});
