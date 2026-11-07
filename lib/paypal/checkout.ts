import { randomUUID } from "node:crypto";
import { paypalFailure, paypalFetch, PayPalError } from "@/lib/paypal/client";

export type CheckoutCapture = {
  id: string;
  status: string;
  amount: { currency_code: string; value: string };
  custom_id?: string;
  create_time?: string;
};

export type CheckoutOrder = {
  id: string;
  status: string;
  payer?: { name?: { given_name?: string } };
  purchase_units?: { custom_id?: string; payments?: { captures?: CheckoutCapture[] } }[];
};

const REPRESENTATION = { Prefer: "return=representation" };

export async function createOrder(args: {
  value: string;
  currency: string;
  description: string;
  customId: string;
}): Promise<CheckoutOrder> {
  const response = await paypalFetch("/v2/checkout/orders", {
    method: "POST",
    headers: { ...REPRESENTATION, "PayPal-Request-Id": randomUUID() },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          description: args.description.slice(0, 127),
          custom_id: args.customId,
          amount: { currency_code: args.currency, value: args.value },
        },
      ],
      application_context: { shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW" },
    }),
  });
  if (!response.ok) throw await paypalFailure("Create order", response);
  return (await response.json()) as CheckoutOrder;
}

// Null when PayPal does not know the order. An unapproved order expires and goes 404.
export async function getOrder(orderId: string): Promise<CheckoutOrder | null> {
  const response = await paypalFetch(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw await paypalFailure("Get order", response);
  return (await response.json()) as CheckoutOrder;
}

// Safe to call twice for one order: the request id is derived from the order, and
// an order that is already captured is read back instead of being an error.
export async function captureOrder(orderId: string): Promise<CheckoutOrder> {
  const response = await paypalFetch(
    `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
    {
      method: "POST",
      headers: { ...REPRESENTATION, "PayPal-Request-Id": `capture-${orderId}` },
      body: "{}",
    },
  );
  if (response.ok) return (await response.json()) as CheckoutOrder;

  const failure = await paypalFailure("Capture order", response);
  if (failure.issue !== "ORDER_ALREADY_CAPTURED") throw failure;
  const order = await getOrder(orderId);
  if (!order) throw new PayPalError("Read captured order", 404);
  return order;
}
