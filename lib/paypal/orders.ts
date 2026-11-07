import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";

type LedgerDonation = {
  paypalOrderId: string;
  paypalCaptureId: string | null;
  amountMinor: number;
  currency: string;
};

export type OrderConfirmation = { confirmed: true } | { confirmed: false; reason: string };

type Capture = { id: string; status: string; amount: { currency_code: string; value: string } };
type Order = {
  ok?: boolean;
  status?: number | string;
  purchase_units?: { payments?: { captures?: Capture[] } }[];
};

type ReadTool = { execute: (input: { id: string }, options: object) => Promise<string> };

// Read only, and sandbox only. Never widen this: the toolkit's other tools move money.
function getOrderTool(): ReadTool {
  const toolkit = new PayPalAgentToolkit({
    clientId: process.env.PAYPAL_CLIENT_ID ?? "",
    clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? "",
    configuration: { actions: { orders: { get: true } }, context: { sandbox: true } },
  });
  return (toolkit.getTools() as unknown as { get_order: ReadTool }).get_order;
}

// The tool returns JSON text, and reports failures as { ok: false } without
// throwing. Throwing here means "could not tell", which is not the same as a
// mismatch. The reasons carry no payer details, because they end up as evidence.
export function compareOrder(rawOrder: string, donation: LedgerDonation): OrderConfirmation {
  const order = JSON.parse(rawOrder) as Order;
  if (order.ok === false) {
    if (order.status === 404) return { confirmed: false, reason: "Order not found in PayPal" };
    throw new Error(`PayPal get_order failed with status ${order.status}`);
  }

  const capture = order.purchase_units
    ?.flatMap((unit) => unit.payments?.captures ?? [])
    .find((c) => c.id === donation.paypalCaptureId);
  if (!capture) return { confirmed: false, reason: "Capture not found on the order" };
  if (capture.status !== "COMPLETED") {
    return { confirmed: false, reason: `Capture is ${capture.status}` };
  }
  if (capture.amount.currency_code !== donation.currency) {
    return { confirmed: false, reason: `Capture is in ${capture.amount.currency_code}` };
  }
  if (Math.round(Number(capture.amount.value) * 100) !== donation.amountMinor) {
    return { confirmed: false, reason: "Capture amount differs from the ledger" };
  }
  return { confirmed: true };
}

export async function confirmDonation(donation: LedgerDonation): Promise<OrderConfirmation> {
  const raw = await getOrderTool().execute({ id: donation.paypalOrderId }, {});
  return compareOrder(raw, donation);
}
