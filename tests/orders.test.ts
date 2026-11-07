import { describe, expect, it } from "vitest";
import { compareOrder } from "@/lib/paypal/orders";

const donation = {
  paypalOrderId: "ORDER",
  paypalCaptureId: "CAPTURE",
  amountMinor: 75_000,
  currency: "PHP",
};

const order = (capture: object) =>
  JSON.stringify({
    status: "COMPLETED",
    purchase_units: [
      {
        payments: {
          captures: [
            {
              id: "CAPTURE",
              status: "COMPLETED",
              amount: { currency_code: "PHP", value: "750.00" },
              ...capture,
            },
          ],
        },
      },
    ],
  });

describe("compareOrder", () => {
  it("confirms a matching completed capture", () => {
    expect(compareOrder(order({}), donation)).toEqual({ confirmed: true });
  });

  it.each([
    [{ status: "REFUNDED" }, "Capture is REFUNDED"],
    [{ status: "PENDING" }, "Capture is PENDING"],
    [{ id: "OTHER" }, "Capture not found on the order"],
    [{ amount: { currency_code: "USD", value: "750.00" } }, "Capture is in USD"],
    [{ amount: { currency_code: "PHP", value: "750.01" } }, "Capture amount differs from the ledger"],
  ])("reports %j as a mismatch", (capture, reason) => {
    expect(compareOrder(order(capture), donation)).toEqual({ confirmed: false, reason });
  });

  it("treats a donation with no capture id as a mismatch", () => {
    expect(compareOrder(order({}), { ...donation, paypalCaptureId: null })).toMatchObject({
      confirmed: false,
    });
  });

  it("treats a missing order as a mismatch, as the toolkit reports it", () => {
    const missing = JSON.stringify({ ok: false, status: 404, code: "PAYPAL_API_HTTP_ERROR" });
    expect(compareOrder(missing, donation)).toEqual({
      confirmed: false,
      reason: "Order not found in PayPal",
    });
  });

  it("throws on any other failure, because that is not evidence of a mismatch", () => {
    const failure = JSON.stringify({ ok: false, status: 503 });
    expect(() => compareOrder(failure, donation)).toThrow(/503/);
  });

  it("does not confuse an order's own status with a failure", () => {
    expect(compareOrder(order({}), donation).confirmed).toBe(true);
  });
});
