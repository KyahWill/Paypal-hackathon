import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as captureRoute } from "@/app/api/donations/orders/[orderId]/capture/route";
import { POST as createRoute } from "@/app/api/donations/orders/route";
import { POST as webhookRoute } from "@/app/api/webhooks/paypal/route";
import { prisma } from "@/lib/db";
import { truncateAllTables } from "@/lib/db-reset";
import { encodeCustomId } from "@/lib/donations";
import type { CheckoutOrder } from "@/lib/paypal/checkout";

const ORDER_ID = "5O190127TN364715T";

let projectId: string;
let slug: string;
let requests: { path: string; init?: RequestInit }[];
// What the fake PayPal answers, keyed by "METHOD path".
let replies: Record<string, () => Response>;

const json = (body: unknown, status = 200) => Response.json(body, { status });

function completedOrder(capture: object = {}): CheckoutOrder {
  return {
    id: ORDER_ID,
    status: "COMPLETED",
    payer: { name: { given_name: "Maria" } },
    purchase_units: [
      {
        custom_id: encodeCustomId(projectId, false),
        payments: {
          captures: [
            {
              id: "CAPTURE1",
              status: "COMPLETED",
              amount: { currency_code: "PHP", value: "500.00" },
              ...capture,
            },
          ],
        },
      },
    ],
  };
}

beforeEach(async () => {
  await truncateAllTables(prisma);
  const charity = await prisma.charity.create({
    data: { name: "Test Charity", payoutEmail: "charity@example.test" },
  });
  slug = randomUUID();
  const project = await prisma.project.create({
    data: {
      charityId: charity.id,
      slug,
      title: "Test Project",
      story: "Testing",
      purpose: "Testing",
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-12-31"),
      goalMinor: 1_000_000,
      currency: "PHP",
    },
  });
  projectId = project.id;

  vi.stubEnv("CURRENCY", "PHP");
  vi.stubEnv("PAYPAL_CLIENT_ID", "client");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "secret");
  vi.stubEnv("PAYPAL_WEBHOOK_ID", "WH-1");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});

  requests = [];
  replies = {};
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/v1/oauth2/token") return json({ access_token: "token", expires_in: 3600 });
    requests.push({ path, init });
    const reply = replies[`${init?.method ?? "GET"} ${path}`];
    if (!reply) throw new Error(`Unexpected PayPal call: ${path}`);
    return reply();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(() => prisma.$disconnect());

const CREATE = "POST /v2/checkout/orders";
const CAPTURE = `POST /v2/checkout/orders/${ORDER_ID}/capture`;
const GET_ORDER = `GET /v2/checkout/orders/${ORDER_ID}`;
const VERIFY = "POST /v1/notifications/verify-webhook-signature";

const signatureSent = () => requests.find((r) => r.path.includes("verify-webhook"));

function create(body: unknown) {
  return createRoute(
    new Request("http://test/api/donations/orders", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

function capture(orderId = ORDER_ID) {
  return captureRoute(new Request("http://test", { method: "POST" }), {
    params: Promise.resolve({ orderId }),
  });
}

const signed = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
  "paypal-transmission-id": "id",
  "paypal-transmission-sig": "sig",
  "paypal-transmission-time": "2026-11-07T06:00:00Z",
};

const captureEvent = {
  id: "WH-EVENT",
  event_type: "PAYMENT.CAPTURE.COMPLETED",
  resource: { id: "CAPTURE1", supplementary_data: { related_ids: { order_id: ORDER_ID } } },
};

function webhook(body: unknown = captureEvent, headers: Record<string, string> = signed) {
  return webhookRoute(
    new Request("http://test/api/webhooks/paypal", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("create order route", () => {
  it("creates an order from server values and writes nothing", async () => {
    replies[CREATE] = () => json({ id: ORDER_ID, status: "CREATED" }, 201);

    const response = await create({ slug, amountMinor: 50_050, anonymous: true });

    expect(await response.json()).toEqual({ orderId: ORDER_ID });
    const unit = JSON.parse(requests[0].init!.body as string).purchase_units[0];
    expect(unit.amount).toEqual({ currency_code: "PHP", value: "500.50" });
    expect(unit.custom_id).toBe(encodeCustomId(projectId, true));
    expect(await prisma.donation.count()).toBe(0);
  });

  it.each([
    ["below the minimum", { amountMinor: 4_999 }],
    ["above the maximum", { amountMinor: 10_000_001 }],
    ["a fraction of a centavo", { amountMinor: 5_000.5 }],
    ["a string", { amountMinor: "5000" }],
  ])("refuses %s", async (_, body) => {
    const response = await create({ slug, anonymous: false, ...body });
    expect(response.status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it("returns 404 for an unknown project", async () => {
    const response = await create({ slug: "nope", amountMinor: 5_000, anonymous: false });
    expect(response.status).toBe(404);
    expect(requests).toHaveLength(0);
  });

  it("will not create an order in a currency other than the app's", async () => {
    vi.stubEnv("CURRENCY", "USD");
    const response = await create({ slug, amountMinor: 5_000, anonymous: false });
    expect(response.status).toBe(502);
    expect(requests).toHaveLength(0);
  });

  it("gives a friendly error, not PayPal's, when PayPal fails", async () => {
    replies[CREATE] = () => json({ name: "INTERNAL_SERVER_ERROR" }, 500);
    const response = await create({ slug, amountMinor: 5_000, anonymous: false });
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain("INTERNAL_SERVER_ERROR");
  });
});

describe("capture route", () => {
  it("records a completed capture and returns the updated progress", async () => {
    replies[CAPTURE] = () => json(completedOrder(), 201);

    const response = await capture();

    expect(await response.json()).toMatchObject({
      status: "completed",
      progress: { raisedMinor: 50_000, goalMinor: 1_000_000, percent: 5, donorCount: 1 },
    });
    expect(await prisma.donation.count()).toBe(1);
  });

  it("derives the request id from the order, so a retry cannot capture twice", async () => {
    replies[CAPTURE] = () => json(completedOrder(), 201);
    await capture();
    await capture();
    const ids = requests.map((r) => (r.init!.headers as Record<string, string>)["PayPal-Request-Id"]);
    expect(ids).toEqual([`capture-${ORDER_ID}`, `capture-${ORDER_ID}`]);
    expect(await prisma.donation.count()).toBe(1);
  });

  it("reads the order back when PayPal says it is already captured", async () => {
    replies[CAPTURE] = () =>
      json({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] }, 422);
    replies[GET_ORDER] = () => json(completedOrder());

    const response = await capture();

    expect((await response.json()).status).toBe("completed");
    expect(await prisma.donation.count()).toBe(1);
  });

  it("records nothing for a pending capture", async () => {
    replies[CAPTURE] = () => json(completedOrder({ status: "PENDING" }), 201);

    const response = await capture();

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "pending" });
    expect(await prisma.donation.count()).toBe(0);
  });

  it("flags a declined instrument so the buttons can restart", async () => {
    replies[CAPTURE] = () =>
      json({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] }, 422);

    const response = await capture();

    expect(await response.json()).toEqual({ status: "declined" });
    expect(await prisma.donation.count()).toBe(0);
  });

  it("refuses an order id that is not one, before calling PayPal", async () => {
    expect((await capture("../../v1/payments")).status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it("fails without recording when PayPal fails", async () => {
    replies[CAPTURE] = () => json({ name: "INTERNAL_SERVER_ERROR" }, 500);
    expect((await capture()).status).toBe(502);
    expect(await prisma.donation.count()).toBe(0);
  });
});

describe("webhook route", () => {
  const verifies = (status: string) => () => json({ verification_status: status });

  it("records a verified capture from PayPal's own order", async () => {
    replies[VERIFY] = verifies("SUCCESS");
    replies[GET_ORDER] = () => json(completedOrder());

    expect((await webhook()).status).toBe(200);

    expect(await prisma.donation.findMany()).toMatchObject([
      { paypalOrderId: ORDER_ID, paypalCaptureId: "CAPTURE1", amountMinor: 50_000, donorName: "Maria" },
    ]);
  });

  it("sends the raw body to PayPal unchanged", async () => {
    replies[VERIFY] = verifies("SUCCESS");
    replies[GET_ORDER] = () => json(completedOrder());
    const raw = JSON.stringify(captureEvent, null, 2).replace('"id"', ' "id"');

    await webhook(raw);

    const sent = signatureSent()!.init!.body as string;
    expect(sent).toContain(`"webhook_event":${raw}}`);
    expect(JSON.parse(sent)).toMatchObject({
      webhook_id: "WH-1",
      transmission_id: "id",
      auth_algo: "SHA256withRSA",
    });
  });

  it("does not double count after the capture route, or on a replay", async () => {
    replies[CAPTURE] = () => json(completedOrder(), 201);
    replies[VERIFY] = verifies("SUCCESS");
    replies[GET_ORDER] = () => json(completedOrder());

    await capture();
    expect((await webhook()).status).toBe(200);
    expect((await webhook()).status).toBe(200);

    expect(await prisma.donation.count()).toBe(1);
  });

  it("refuses an event PayPal does not confirm", async () => {
    replies[VERIFY] = verifies("FAILURE");
    expect((await webhook()).status).toBe(400);
    expect(await prisma.donation.count()).toBe(0);
    expect(requests.map((r) => r.path)).toEqual(["/v1/notifications/verify-webhook-signature"]);
  });

  it("refuses when PayPal rejects the signature values outright", async () => {
    replies[VERIFY] = () => json({ name: "VALIDATION_ERROR" }, 400);
    expect((await webhook()).status).toBe(400);
  });

  it("refuses an unsigned post without asking PayPal", async () => {
    expect((await webhook(captureEvent, {})).status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it("refuses a body that is not JSON", async () => {
    expect((await webhook("not json")).status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it("fails closed when PAYPAL_WEBHOOK_ID is not set", async () => {
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "");
    expect((await webhook()).status).toBe(500);
    expect(requests).toHaveLength(0);
    expect(await prisma.donation.count()).toBe(0);
  });

  it("asks PayPal to retry when verification cannot run", async () => {
    replies[VERIFY] = () => json({ name: "INTERNAL_SERVER_ERROR" }, 500);
    expect((await webhook()).status).toBe(500);
  });

  it("asks PayPal to retry when the order cannot be read", async () => {
    replies[VERIFY] = verifies("SUCCESS");
    replies[GET_ORDER] = () => json({ name: "INTERNAL_SERVER_ERROR" }, 500);
    expect((await webhook()).status).toBe(500);
    expect(await prisma.donation.count()).toBe(0);
  });

  it("acknowledges other event types without recording", async () => {
    replies[VERIFY] = verifies("SUCCESS");
    const event = { ...captureEvent, event_type: "PAYMENT.CAPTURE.REFUNDED" };
    expect((await webhook(event)).status).toBe(200);
    expect(await prisma.donation.count()).toBe(0);
  });

  it("acknowledges an order that is not one of ours", async () => {
    replies[VERIFY] = verifies("SUCCESS");
    replies[GET_ORDER] = () =>
      json({ ...completedOrder(), purchase_units: [{ ...completedOrder().purchase_units![0], custom_id: undefined }] });
    expect((await webhook()).status).toBe(200);
    expect(await prisma.donation.count()).toBe(0);
  });

  it("acknowledges an order PayPal cannot find", async () => {
    replies[VERIFY] = verifies("SUCCESS");
    replies[GET_ORDER] = () => json({}, 404);
    expect((await webhook()).status).toBe(200);
  });

  it("retries when the order does not yet show the capture as completed", async () => {
    replies[VERIFY] = verifies("SUCCESS");
    replies[GET_ORDER] = () => json(completedOrder({ status: "PENDING" }));
    expect((await webhook()).status).toBe(503);
    expect(await prisma.donation.count()).toBe(0);
  });
});
