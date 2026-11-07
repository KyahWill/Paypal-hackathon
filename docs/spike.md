# API spike findings

Date: 2026-11-07. Reproduce with `npm run spike` (or `npm run spike -- toolkit|payout|vision`).

**Status: incomplete.** Live run on 2026-11-07 with `CURRENCY=PHP` and `GEMINI_MODEL=gemini-3.5-flash-lite`. Both remaining blockers are account setup, not code. A delivered payout and a Gemini response are still unproven.

| Step | Result |
| --- | --- |
| a. Toolkit tool listing | Done: 47 tools, no payout tool |
| a2. Toolkit tools under `ai@7` | Broken directly, works wrapped (mock model) |
| a3. Live `list_transactions` read | Pass: returned 1 transaction |
| b. OAuth | Pass: payouts scope present |
| b. PHP payout | **Accepted, not delivered**: item `UNCLAIMED`, receiver is not a sandbox account |
| b. USD retry | **Rejected**: 422 `INSUFFICIENT_FUNDS`, sender has 0.00 USD |
| c. Gemini vision + `generateObject` | **Blocked**: 403 `API_KEY_SERVICE_BLOCKED`, no model response |

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

The schema fix was proven against a mock model only. The toolkit's `execute` works live against sandbox when called directly (`list_transactions`), but a real tool call from Gemini through the wrapper has not been run.

The two alternatives are pinning the whole app to `ai@4`, or skipping the toolkit and calling Orders directly. The wrapper is the recommendation, but the toolkit is a hackathon requirement question for the project owner to confirm, not one this spike can settle.

## b. Sandbox payout

One payout was sent: batch `3GHGERDC6XFY4`, PHP 1.00. The USD attempt was refused before anything was created.

**PHP is accepted but delivery is unproven.** PayPal took the batch with HTTP 201 and processed it in about 30 seconds:

```
t+6s   batch=PENDING     item=PENDING
t+12s  batch=PROCESSING  item=PENDING
t+18s  batch=PROCESSING  item=UNCLAIMED
t+30s  batch=SUCCESS     item=UNCLAIMED
```

The item failed with `RECEIVER_UNREGISTERED`. `PAYPAL_CHARITY_RECEIVER_EMAIL` is a gmail.com address, and sandbox payouts only reach sandbox accounts. This says nothing against PHP. The funds return after 30 days if unclaimed.

**The USD failure is not a currency result.** The sender's sandbox balances are PHP 5,000.00 and USD 0.00, so PayPal answered `INSUFFICIENT_FUNDS`. USD remains untested. It only matters if PHP fails against a real sandbox receiver.

Effects on the design:

- **`batch_status` must not be used to mark a claim paid.** This batch reached `SUCCESS` while no money was delivered. `PAID` must require item `transaction_status` of `SUCCESS`.
- **`UNCLAIMED` needs a home in the claim lifecycle.** CLAUDE.md only has "PAYING -> ESCALATED (payout failed)". Treating `UNCLAIMED` as failed fits that path, but the money stays out of the sender's hands until it is returned, so a retry could double spend the pool. Needs a decision before `executeReimbursement`.
- **Payouts have a fee.** PHP 0.02 on PHP 1.00, charged to the sender on top of the amount. Verifier check 2 ignores this, so a claim for the full balance could leave the pool short. Only one data point, so the fee formula is unknown.
- **Settlement is quick enough to show live** in the demo, at about 30 seconds in this one run.

The sender's balance still read PHP 5,000.00 after this payout. Unexplained: it may be reporting lag, or how sandbox treats an unclaimed payout. Do not rely on `/v1/reporting/balances` being instantly current.

The script only talks to `api-m.sandbox.paypal.com` (hardcoded), and sends a fresh payout on every run of the `payout` step.

## c. Gemini vision

**Not proven.** Google refused the request before reaching any model, so this tells us nothing about vision or structured output.

```
403 PERMISSION_DENIED, reason API_KEY_SERVICE_BLOCKED
```

`ListModels` gets the same 403, so this is the key and not the model name. The API key's restrictions block `generativelanguage.googleapis.com`. Whether `gemini-3.5-flash-lite` exists is also still unknown.

The script reads `scripts/fixtures/test-receipt.png`, a generated receipt with known values (Maligaya Dry Goods, 2026-10-14, 3 items, PHP 4,450.00), and checks each extracted field against them.

The SDK printed two deprecation warnings at runtime, both for code the spike uses as requested. New code in Phase 1 should probably use the replacements:

- `generateObject`: use `generateText` with an `output` setting
- `"image"` content part: use a `"file"` part with an image `mediaType`

## Other things found

- **`prisma@latest` is a release candidate** (8.0.0-rc.33). Pinned to stable 7.10.1 instead.
- **`prisma init` added unrequested files**: third-party agent skills in `.agents/`, `.claude/`, `.windsurf/` plus `skills-lock.json`. Removed. It also named its config `prisma7.config.ts`, renamed to `prisma.config.ts`.
- **`create-next-app` refuses a directory containing `CLAUDE.md`**, so it was scaffolded elsewhere and copied in. `CLAUDE.md` is unchanged. Next also generates `AGENTS.md`, and `next dev` re-adds its block, so it is committed.
- **npm registry on this machine is plaintext** (`http://registry.npmjs.org/`). The project `.npmrc` forces https.
- **`npm audit`** reports 12 production vulnerabilities (11 high). The ones shown come through the toolkit's dependency tree (old `openai`, `zod` range). Not fixed, because `npm audit fix --force` could break the toolkit. Reassess before deploying.
- **The Google provider needs `GOOGLE_GENERATIVE_AI_API_KEY`**, not `GEMINI_API_KEY`.

## To finish the spike

1. Set `PAYPAL_CHARITY_RECEIVER_EMAIL` to a sandbox Personal account (developer.paypal.com > Testing Tools > Sandbox Accounts). Then run `npm run spike -- payout`.
2. Remove the API restriction on the Gemini key, or create a new key in Google AI Studio. Then run `npm run spike -- vision`.

## Sandbox donation captures

Card-funded orders with no buyer step do not work on this account: `POST /v2/checkout/orders` with `payment_source.card` and test card 4111 1111 1111 1111 returned 422 `PAYER_CANNOT_PAY` (PHP 1.00, nothing created). Cause not established. Seeded donations therefore use the normal buyer approval flow through `npm run donations:capture`.

## Still unverified

- From memory, not tested: PayPal's Transaction Search data can lag by up to a few hours. If so, `list_transactions` could miss a fresh donation and wrongly trigger `ESCALATED_LEDGER_MISMATCH`, and `get_order` is the better tool for verifier check 6.
- Rule 3 assumes PayPal rejects a repeated `sender_batch_id`. Not tested here, because it means deliberately attempting a second payout.
