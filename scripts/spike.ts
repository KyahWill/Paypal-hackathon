/**
 * API de-risking spike. Not application code.
 *
 *   npm run spike                  all steps
 *   npm run spike -- toolkit       Agent Toolkit tools (needs no credentials for the name listing)
 *   npm run spike -- payout        sends a real sandbox payout on every run
 *   npm run spike -- vision        Gemini vision + structured output
 *
 * Findings live in docs/spike.md.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { google } from "@ai-sdk/google";
import {
  ALL_TOOLS_ENABLED,
  PayPalAgentToolkit,
} from "@paypal/agent-toolkit/ai-sdk";
import { generateObject, generateText, stepCountIs, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";

// Hardcoded on purpose: this script must never be able to reach live PayPal.
const PAYPAL_SANDBOX_BASE = "https://api-m.sandbox.paypal.com";
const PAYOUT_AMOUNT = "1.00";
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 240_000;
const TERMINAL_BATCH = new Set(["SUCCESS", "DENIED", "CANCELED"]);
const PAYOUT_LIKE = /payout|disburs|transfer|send_money|batch/i;
// The least privilege Leslie needs for verifier check 6.
const READ_ONLY_ACTIONS = { orders: { get: true }, transactions: { list: true } };

type Outcome = "PASS" | "FAIL" | "SKIPPED";
const results: { step: string; outcome: Outcome; note: string }[] = [];

function record(step: string, outcome: Outcome, note: string) {
  results.push({ step, outcome, note });
  console.log(`\n[${outcome}] ${step}: ${note}`);
}

function heading(text: string) {
  console.log(`\n=== ${text} ===`);
}

function missingEnv(...names: string[]) {
  return names.filter((name) => !process.env[name]);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function makeToolkit(actions: Record<string, Record<string, boolean>>) {
  return new PayPalAgentToolkit({
    // Listing tools makes no network call, so placeholders are enough for that.
    clientId: process.env.PAYPAL_CLIENT_ID || "placeholder",
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || "placeholder",
    configuration: { actions, context: { sandbox: true } },
  });
}

type LooseTool = {
  description?: string;
  parameters?: unknown;
  inputSchema?: unknown;
  execute?: (input: unknown) => Promise<unknown>;
};

/** Runs tools through ai@7 with a mock model and returns the schema the model would be sent. */
async function schemasSentToModel(tools: Record<string, unknown>) {
  let sent: unknown;
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      sent = options.tools;
      return {
        content: [{ type: "text", text: "ok" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  await generateText({
    model,
    prompt: "probe",
    tools: tools as Parameters<typeof generateText>[0]["tools"],
    stopWhen: stepCountIs(1),
  });
  return sent as { name: string; inputSchema?: { properties?: object } }[];
}

function schemaProps(sent: { name: string; inputSchema?: { properties?: object } }[]) {
  return sent.map((t) => `${t.name}(${Object.keys(t.inputSchema?.properties ?? {}).join(",")})`);
}

async function stepToolkit() {
  heading("a. Agent Toolkit tools (sandbox)");
  const all = makeToolkit(ALL_TOOLS_ENABLED).getTools();
  const names = Object.keys(all);
  console.log(`${names.length} tools with ALL_TOOLS_ENABLED:`);
  for (const name of names) console.log(`  ${name}`);

  const payoutTools = names.filter((name) => PAYOUT_LIKE.test(name));
  record(
    "toolkit payout tool",
    "PASS",
    payoutTools.length
      ? `payout-like tools exist: ${payoutTools.join(", ")}`
      : `NO payout tool exists among ${names.length} tools`,
  );

  const readOnly = makeToolkit(READ_ONLY_ACTIONS).getTools() as Record<string, LooseTool>;
  console.log(`\nRead-only config exposes: ${Object.keys(readOnly).join(", ")}`);

  heading("a2. Do toolkit tools work under ai@7? (mock model, offline)");
  const sample = readOnly.get_order;
  console.log(`Tool keys: ${Object.keys(sample).join(", ")}`);
  try {
    const direct = schemaProps(await schemasSentToModel(readOnly));
    console.log(`Passed directly, model would see: ${direct.join(" ")}`);
    const lost = direct.some((entry) => entry.endsWith("()"));
    record(
      "toolkit tools direct under ai@7",
      lost ? "FAIL" : "PASS",
      lost ? "tools reach the model with an empty input schema" : "schemas survive",
    );
  } catch (error) {
    record("toolkit tools direct under ai@7", "FAIL", errorMessage(error));
  }

  try {
    const adapted = Object.fromEntries(
      Object.entries(readOnly).map(([name, t]) => [
        name,
        tool({
          description: t.description,
          inputSchema: t.parameters as z.ZodType<Record<string, unknown>>,
          execute: async (input) => t.execute?.(input),
        }),
      ]),
    );
    const wrapped = schemaProps(await schemasSentToModel(adapted));
    console.log(`Wrapped with ai@7 tool(), model would see: ${wrapped.join(" ")}`);
    const lost = wrapped.some((entry) => entry.endsWith("()"));
    record(
      "toolkit tools wrapped for ai@7",
      lost ? "FAIL" : "PASS",
      lost ? "schema still lost when wrapped" : "schemas survive a one-line tool() wrapper",
    );
  } catch (error) {
    record("toolkit tools wrapped for ai@7", "FAIL", errorMessage(error));
  }

  heading("a3. Live read through toolkit: list_transactions");
  const missing = missingEnv("PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET");
  if (missing.length) {
    record("toolkit live read", "SKIPPED", `missing ${missing.join(", ")}`);
    return;
  }
  try {
    const raw = await readOnly.list_transactions.execute?.({ search_months: 1 });
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    if (/error/i.test(text.slice(0, 200))) {
      record("toolkit live read", "FAIL", text.slice(0, 300));
      return;
    }
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const count = parsed?.transaction_details?.length ?? parsed?.total_items ?? "unknown";
    record("toolkit live read", "PASS", `list_transactions returned, transactions: ${count}`);
  } catch (error) {
    record("toolkit live read", "FAIL", errorMessage(error).slice(0, 300));
  }
}

async function getPayPalToken() {
  const credentials = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`,
  ).toString("base64");
  const response = await fetch(`${PAYPAL_SANDBOX_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`OAuth ${response.status}: ${body.error ?? ""} ${body.error_description ?? ""}`);
  }
  const scopes = String(body.scope ?? "").split(" ");
  return {
    token: body.access_token as string,
    hasPayoutScope: scopes.some((scope) => scope.includes("payments/payouts")),
    scopeCount: scopes.length,
  };
}

type PayoutResult = {
  currency: string;
  settled: boolean;
  httpStatus?: number;
  batchId?: string;
  batchStatus?: string;
  itemStatus?: string;
  itemErrors?: string;
  error?: string;
  seconds?: number;
};

async function sendPayout(token: string, currency: string): Promise<PayoutResult> {
  const receiver = process.env.PAYPAL_CHARITY_RECEIVER_EMAIL;
  const stamp = Date.now();
  const response = await fetch(`${PAYPAL_SANDBOX_BASE}/v1/payments/payouts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      sender_batch_header: {
        sender_batch_id: `spike-${currency}-${stamp}`,
        email_subject: "Leslie spike test payout",
        recipient_type: "EMAIL",
      },
      items: [
        {
          recipient_type: "EMAIL",
          amount: { value: PAYOUT_AMOUNT, currency },
          receiver,
          note: "Leslie spike test",
          sender_item_id: `spike-item-${stamp}`,
        },
      ],
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    return {
      currency,
      settled: false,
      httpStatus: response.status,
      error: `${body.name ?? ""}: ${body.message ?? ""} ${JSON.stringify(body.details ?? [])} debug_id=${body.debug_id ?? ""}`,
    };
  }
  const batchId: string = body.batch_header.payout_batch_id;
  console.log(`  ${currency}: batch ${batchId} created (${body.batch_header.batch_status})`);

  const started = Date.now();
  while (Date.now() - started < POLL_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const poll = await fetch(`${PAYPAL_SANDBOX_BASE}/v1/payments/payouts/${batchId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const state = await poll.json();
    if (!poll.ok) {
      console.log(`  ${currency}: poll HTTP ${poll.status}, retrying`);
      continue;
    }
    const batchStatus: string = state.batch_header.batch_status;
    const item = state.items?.[0];
    const itemStatus: string | undefined = item?.transaction_status;
    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(`  ${currency}: t+${seconds}s batch=${batchStatus} item=${itemStatus}`);
    // A batch can be SUCCESS while its item is UNCLAIMED or FAILED, so the item decides.
    const itemPending = !itemStatus || itemStatus === "PENDING";
    if (TERMINAL_BATCH.has(batchStatus) && !itemPending) {
      return {
        currency,
        settled: true,
        httpStatus: response.status,
        batchId,
        batchStatus,
        itemStatus,
        itemErrors: item?.errors ? JSON.stringify(item.errors) : undefined,
        seconds,
      };
    }
  }
  return {
    currency,
    settled: false,
    httpStatus: response.status,
    batchId,
    error: `did not settle within ${POLL_TIMEOUT_MS / 1000}s`,
  };
}

function describePayout(result: PayoutResult) {
  return JSON.stringify(result);
}

async function stepPayout() {
  heading("b. Sandbox payout");
  const missing = missingEnv(
    "PAYPAL_CLIENT_ID",
    "PAYPAL_CLIENT_SECRET",
    "PAYPAL_CHARITY_RECEIVER_EMAIL",
    "CURRENCY",
  );
  if (missing.length) {
    record("payout", "SKIPPED", `missing ${missing.join(", ")}`);
    return;
  }
  const currency = process.env.CURRENCY as string;

  let auth: Awaited<ReturnType<typeof getPayPalToken>>;
  try {
    auth = await getPayPalToken();
  } catch (error) {
    record("paypal oauth", "FAIL", errorMessage(error));
    return;
  }
  record(
    "paypal oauth",
    "PASS",
    `token received, ${auth.scopeCount} scopes, payouts scope: ${auth.hasPayoutScope}`,
  );

  const first = await sendPayout(auth.token, currency);
  const firstOk = first.settled && first.itemStatus === "SUCCESS";
  record(`payout ${currency}`, firstOk ? "PASS" : "FAIL", describePayout(first));

  // A timeout is not a failure: the money may still land, so do not send a second one.
  const definitelyFailed = !firstOk && !first.error?.startsWith("did not settle");
  if (definitelyFailed && currency !== "USD") {
    console.log(`\n${currency} failed, retrying in USD`);
    const retry = await sendPayout(auth.token, "USD");
    const retryOk = retry.settled && retry.itemStatus === "SUCCESS";
    record("payout USD (retry)", retryOk ? "PASS" : "FAIL", describePayout(retry));
  }
}

const ReceiptSchema = z.object({
  vendor: z.string(),
  date: z.string().describe("Purchase date as YYYY-MM-DD"),
  lineItems: z.array(z.object({ description: z.string(), amount: z.number() })),
  total: z.number(),
  currency: z.string().describe("ISO 4217 code"),
  confidence: z.number().describe("0 to 1, how sure you are of this reading"),
});

async function stepVision() {
  heading("c. Gemini vision + structured output");
  const missing = missingEnv("GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_MODEL");
  if (missing.length) {
    record("gemini vision", "SKIPPED", `missing ${missing.join(", ")}`);
    return;
  }
  const image = readFileSync(join(process.cwd(), "scripts/fixtures/test-receipt.png"));
  try {
    const { object, usage } = await generateObject({
      model: google(process.env.GEMINI_MODEL as string),
      schema: ReceiptSchema,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Read this receipt and extract its details." },
            { type: "image", image, mediaType: "image/png" },
          ],
        },
      ],
    });
    console.log(JSON.stringify(object, null, 2));
    console.log(`Tokens: ${usage.inputTokens} in, ${usage.outputTokens} out`);
    const checks = {
      vendor: /maligaya/i.test(object.vendor),
      date: object.date === "2026-10-14",
      total: object.total === 4450,
      currency: object.currency === "PHP",
      lineItems: object.lineItems.length === 3,
    };
    const wrong = Object.entries(checks).filter(([, ok]) => !ok).map(([key]) => key);
    record(
      "gemini vision",
      wrong.length ? "FAIL" : "PASS",
      wrong.length ? `misread: ${wrong.join(", ")}` : `all fields correct, confidence ${object.confidence}`,
    );
  } catch (error) {
    record("gemini vision", "FAIL", errorMessage(error).slice(0, 500));
  }
}

const steps = { toolkit: stepToolkit, payout: stepPayout, vision: stepVision };

async function main() {
  const requested = process.argv.slice(2);
  const unknown = requested.filter((name) => !(name in steps));
  if (unknown.length) throw new Error(`Unknown step: ${unknown.join(", ")}`);
  const names = (requested.length ? requested : Object.keys(steps)) as (keyof typeof steps)[];
  for (const name of names) await steps[name]();

  heading("Summary");
  for (const { step, outcome, note } of results) {
    console.log(`${outcome.padEnd(8)}${step}: ${note}`);
  }
}

// The toolkit leaves handles open, so exit explicitly.
main().then(
  () => process.exit(results.some((r) => r.outcome === "FAIL") ? 1 : 0),
  (error) => {
    console.error(errorMessage(error));
    process.exit(1);
  },
);
