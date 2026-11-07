// Creates a real sandbox order for each seeded donation, waits for a sandbox
// buyer to approve it in the browser, then captures it. Run with
// `npm run donations:capture`. Progress is saved after every step, so it can be
// stopped and re-run. The ids it writes are committed for db:reset to use.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { DONATIONS, PROJECT } from "../seed/data";
import {
  readSandboxDonations,
  SANDBOX_DONATIONS_PATH,
  type SandboxDonation,
} from "../seed/sandbox-donations";

// Hardcoded on purpose: this script must never be able to reach live PayPal.
const PAYPAL_SANDBOX_BASE = "https://api-m.sandbox.paypal.com";
const POLL_INTERVAL_MS = 3_000;
const APPROVAL_TIMEOUT_MS = 10 * 60_000;

type Order = {
  id: string;
  status: string;
  links?: { rel: string; href: string }[];
  purchase_units?: {
    payments?: { captures?: { id: string; status: string; amount: { value: string } }[] };
  }[];
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function getToken() {
  const credentials = `${requireEnv("PAYPAL_CLIENT_ID")}:${requireEnv("PAYPAL_CLIENT_SECRET")}`;
  const response = await fetch(`${PAYPAL_SANDBOX_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(credentials).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!response.ok) throw new Error(`PayPal OAuth failed: ${response.status}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

async function paypal(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${PAYPAL_SANDBOX_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": randomUUID(),
      Prefer: "return=representation",
    },
  });
}

async function failure(step: string, response: Response) {
  const body = (await response.json().catch(() => ({}))) as {
    name?: string;
    details?: { issue?: string }[];
  };
  return new Error(`${step} failed: ${response.status} ${body.name} ${body.details?.[0]?.issue}`);
}

async function createOrder(token: string, amountMinor: number, currency: string) {
  const response = await paypal(token, "/v2/checkout/orders", {
    method: "POST",
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          description: `Donation: ${PROJECT.title}`.slice(0, 127),
          amount: { currency_code: currency, value: (amountMinor / 100).toFixed(2) },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            user_action: "PAY_NOW",
            shipping_preference: "NO_SHIPPING",
            // Nothing needs to serve this page. The script polls PayPal instead.
            return_url: "https://example.com/approved",
            cancel_url: "https://example.com/cancelled",
          },
        },
      },
    }),
  });
  if (!response.ok) throw await failure("Create order", response);
  return (await response.json()) as Order;
}

async function getOrder(token: string, orderId: string): Promise<Order | null> {
  const response = await paypal(token, `/v2/checkout/orders/${orderId}`);
  // An order nobody approved expires, and PayPal then stops finding it.
  if (response.status === 404) return null;
  if (!response.ok) throw await failure("Get order", response);
  return (await response.json()) as Order;
}

async function waitForApproval(token: string, orderId: string) {
  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const order = await getOrder(token, orderId);
    if (order?.status === "APPROVED" || order?.status === "COMPLETED") return order;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for approval of ${orderId}. Re-run to continue.`);
}

// Only COMPLETED counts. A PENDING capture is not money the pool can rely on.
function completedCapture(order: Order, record: SandboxDonation) {
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture) throw new Error(`Order ${order.id} has no capture`);
  if (capture.status !== "COMPLETED") {
    throw new Error(`Capture ${capture.id} is ${capture.status}, expected COMPLETED`);
  }
  if (Math.round(Number(capture.amount.value) * 100) !== record.amountMinor) {
    throw new Error(`Capture ${capture.id} amount differs from the seed data`);
  }
  return capture.id;
}

async function main() {
  const currency = requireEnv("CURRENCY");
  const token = await getToken();
  const records = readSandboxDonations();
  const save = () =>
    writeFileSync(SANDBOX_DONATIONS_PATH, `${JSON.stringify(records, null, 2)}\n`);

  for (const [index, donation] of DONATIONS.entries()) {
    const label = `${index + 1}/${DONATIONS.length} ${donation.donorName}`;
    if (records[index]?.captureId) {
      console.log(`${label}: already captured`);
      continue;
    }

    let order = records[index] ? await getOrder(token, records[index].orderId) : null;
    if (!order) {
      order = await createOrder(token, donation.amountMinor, currency);
      records[index] = {
        donorName: donation.donorName,
        amountMinor: donation.amountMinor,
        orderId: order.id,
        captureId: null,
      };
      save();
    }
    const record = records[index];

    if (order.status !== "APPROVED" && order.status !== "COMPLETED") {
      const approveUrl = (order.links ?? []).find((link) => link.rel.includes("approve"))?.href;
      console.log(
        `\n${label}: ${currency} ${(donation.amountMinor / 100).toFixed(2)}\n` +
          `Open and pay as the sandbox buyer:\n` +
          (approveUrl ?? `https://www.sandbox.paypal.com/checkoutnow?token=${order.id}`),
      );
      order = await waitForApproval(token, order.id);
    }

    if (order.status === "APPROVED") {
      const response = await paypal(token, `/v2/checkout/orders/${order.id}/capture`, {
        method: "POST",
        body: "{}",
      });
      if (!response.ok) throw await failure("Capture order", response);
      order = (await response.json()) as Order;
    }

    record.captureId = completedCapture(order, record);
    save();
    console.log(`${label}: captured`);
  }

  console.log("\nAll donations captured. Next: commit seed/sandbox-donations.json, then npm run db:reset");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
