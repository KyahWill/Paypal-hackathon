# API spike findings

Date: 2026-11-07. Reproduce with `npm run spike` (or `npm run spike -- toolkit|payout|vision`).

**Status: incomplete.** No PayPal or Gemini credentials were available, so only the offline work ran. Nothing below has been tested against a live API yet.

| Step | Status |
| --- | --- |
| a. Toolkit tool listing | Ran (offline, placeholder credentials) |
| a2. Toolkit tools under `ai@7` | Ran (offline, mock model) |
| a3. Live `list_transactions` read | **Not run**, needs PayPal credentials |
| b. OAuth + sandbox payout | **Not run**, needs PayPal credentials |
| c. Gemini vision + `generateObject` | **Not run**, needs Gemini key and `GEMINI_MODEL` |

## Versions

next 16.4.5, ai 7.0.164, @ai-sdk/google 4.0.113, @paypal/agent-toolkit 1.11.0 (with its own nested ai 4.3.19), prisma 7.10.1, iron-session 9.0.1, zod 3.25.76.

## a. Agent Toolkit tools

**No payout tool exists.** With `ALL_TOOLS_ENABLED`, toolkit 1.11.0 exposes 47 tools and none match payout, disburse, transfer, send money or batch. This confirms the plan in CLAUDE.md: Payouts must go through our own client in `lib/paypal/payouts.ts`.

Tools by area:

- Invoices (22): `create_invoice`, `create_recurring_series`, `activate_recurring_series`, `get_recurring_series`, `cancel_recurring_series`, `delete_recurring_series`, `list_invoices`, `get_invoice`, `send_invoice`, `send_invoice_reminder`, `cancel_sent_invoice`, `delete_invoice`, `setup_invoice_auto_reminders`, `update_invoice_auto_reminder`, `search_invoicing`, `update_invoicing`, `cancel_invoice_auto_reminder`, `generate_invoice_qr_code`, `generate_invoice_number`, `record_payment_for_invoice`, `record_refund_for_invoice`, `create_conditional_rules_for_invoice`
- Catalog (4): `create_product`, `list_products`, `update_product`, `show_product_details`
- Subscriptions (8): `create_subscription_plan`, `list_subscription_plans`, `show_subscription_plan_details`, `update_plan`, `create_subscription`, `show_subscription_details`, `cancel_subscription`, `update_subscription`
- Shipment (3): `create_shipment_tracking`, `get_shipment_tracking`, `update_shipment_tracking`
- Orders (3): `create_order`, `get_order`, `pay_order`
- Disputes (3): `list_disputes`, `get_dispute`, `accept_dispute_claim`
- Payments (2): `create_refund`, `get_refund`
- Reporting (2): `list_transactions`, `get_merchant_insights`

**Rule 1 risk.** `create_refund`, `pay_order` and `accept_dispute_claim` all move money. The toolkit must never be built with `ALL_TOOLS_ENABLED` in app code. This config exposes exactly `get_order` and `list_transactions`:

```ts
{ orders: { get: true }, transactions: { list: true } }
```

## a2. Toolkit tools break silently under `ai@7`

This differs from what CLAUDE.md assumes (rule 6).

The toolkit is built against `ai@4`, so npm installs a nested copy and its tools have the v4 shape (`parameters`), while `ai@7` reads `inputSchema`.

- **Passed directly to `generateText`:** no error, but the model is sent an empty schema: `get_order()`, `list_transactions()`. The model would have no way to know it must supply an order id.
- **Wrapped in `ai@7`'s `tool()`:** the schemas survive: `get_order(id)`, `list_transactions(transaction_id, transaction_status, start_date, end_date, search_months, page_size, page)`.

```ts
tool({ description: t.description, inputSchema: t.parameters, execute: (input) => t.execute(input) })
```

This was proven against a mock model only. The wrapper's `execute` has not been run against PayPal, and real tool calling has not been run through Gemini.

The two alternatives are pinning the whole app to `ai@4`, or skipping the toolkit and calling Orders directly. The wrapper is the recommendation, but the toolkit is a hackathon requirement question for the project owner to confirm, not one this spike can settle.

## b. Sandbox payout

Not run. The script is ready and:

- only ever talks to `api-m.sandbox.paypal.com` (hardcoded)
- reports the OAuth scope check, so a missing Payouts feature is obvious
- judges success by the item status, because a batch can be `SUCCESS` while its item is `UNCLAIMED` or `FAILED`
- retries in USD only on a definite failure, not on a poll timeout, because a timed-out payout may still land
- sends a fresh payout on every run of the `payout` step

Questions this must answer: does PHP work as a sandbox payout currency, what status does the item reach, and how long does settlement take.

## c. Gemini vision

Not run. The script reads `scripts/fixtures/test-receipt.png`, a generated receipt with known values (Maligaya Dry Goods, 2026-10-14, 3 items, PHP 4,450.00), and checks each extracted field against them.

`generateObject` still exists in `ai@7` but is marked `@deprecated`: "Use `generateText` with an `output` setting instead." The spike uses `generateObject` as requested. New code in Phase 1 should probably use the replacement. Not yet tested with Gemini.

## Other things found

- **`prisma@latest` is a release candidate** (8.0.0-rc.33). Pinned to stable 7.10.1 instead.
- **`prisma init` added unrequested files**: third-party agent skills in `.agents/`, `.claude/`, `.windsurf/` plus `skills-lock.json`. Removed. It also named its config `prisma7.config.ts`, renamed to `prisma.config.ts`.
- **`create-next-app` refuses a directory containing `CLAUDE.md`**, so it was scaffolded elsewhere and copied in. `CLAUDE.md` is unchanged. Next also generates `AGENTS.md`, and `next dev` re-adds its block, so it is committed.
- **npm registry on this machine is plaintext** (`http://registry.npmjs.org/`). The project `.npmrc` forces https.
- **`npm audit`** reports 12 production vulnerabilities (11 high). The ones shown come through the toolkit's dependency tree (old `openai`, `zod` range). Not fixed, because `npm audit fix --force` could break the toolkit. Reassess before deploying.
- **The Google provider needs `GOOGLE_GENERATIVE_AI_API_KEY`**, not `GEMINI_API_KEY`.

## Unverified, check when credentials arrive

- From memory, not tested: PayPal's Transaction Search data can lag by up to a few hours. If so, `list_transactions` could miss a fresh donation and wrongly trigger `ESCALATED_LEDGER_MISMATCH`, and `get_order` is the better tool for verifier check 6.
- Rule 3 assumes PayPal rejects a repeated `sender_batch_id`. Not tested here, because it means deliberately attempting a second payout.
