# PayPal sandbox

Everything here runs in sandbox. The capture and spike scripts hardcode `api-m.sandbox.paypal.com`, so they cannot reach live PayPal.

## Accounts you need

At developer.paypal.com > Testing Tools > Sandbox Accounts:

| Account | Used for |
| --- | --- |
| Business | The app's merchant account. It receives donations and sends payouts |
| Personal (buyer) | Pays for donations in the sandbox checkout |
| Personal (receiver) | The charity's PayPal. Put this email in `PAYPAL_CHARITY_RECEIVER_EMAIL` |

The app needs these under Apps & Credentials: Payouts, and Transaction Search for `list_transactions`.

**The receiver must be a sandbox account.** A real address gets an `UNCLAIMED` payout, and no money arrives.

## Capturing the seeded donations

The captures are already done and committed in `seed/sandbox-donations.json`. Redo them only if you change `DONATIONS` in `seed/data.ts`, or move to a different sandbox app.

```bash
npm run donations:capture
```

1. The script creates an order and prints an approval link.
2. Open it and pay as the sandbox buyer.
3. You land on `example.com`. Ignore that page. The script is polling PayPal, and it captures the order and prints the next link.
4. When all eight are done, commit `seed/sandbox-donations.json` and run `npm run db:reset`.

You can stop at any time. Re-running skips what is captured and picks up the rest. Each approval link waits up to 10 minutes.

To redo a donation, remove its entry from the JSON file. Entries match `DONATIONS` by position, so changing an amount, a name or the order means redoing the entries from that point. The seed refuses to run until each entry matches.

Only `COMPLETED` captures count. The script stops on anything else.

Automatic card-funded orders do not work on this account: PayPal answers `422 PAYER_CANNOT_PAY`. That is why a buyer has to approve each one.

## Donations

The page is `/p/<slug>`, and the demo project is at `/p/balik-eskwela`.

1. The browser asks `POST /api/donations/orders` for an order. The amount is checked on the server, and nothing is written to our database.
2. The donor approves in PayPal's popup.
3. The browser calls `POST /api/donations/orders/<id>/capture`. A `Donation` row is written only if the capture is `COMPLETED`.
4. If that response never arrives, for example because the tab was closed, `PAYMENT.CAPTURE.COMPLETED` reaches `POST /api/webhooks/paypal` and records the same donation.

Both paths end in `recordCompletedDonation()` in `lib/donations.ts`, the only code that writes a donation. It can run any number of times for one order. The project and the donor's anonymous choice travel on the order as `custom_id`, because no row exists before the capture. Only the first name is stored.

Donations can be refunded in PayPal, but nothing here listens for that yet. The ledger keeps counting a refunded gift, and verifier check 6 escalates the next claim when it sees the capture is no longer `COMPLETED`.

### Tracing a donation

The server log has the id of every order it creates (`Created order <id>`), and of every capture that fails. Successful captures are not logged, so check for the row in `Donation`. The log holds no payer details.

| What PayPal says about the order | Meaning |
| --- | --- |
| `CREATED` | The donor never approved it. No money moved, and no row is expected |
| `APPROVED` | The donor approved but capture never ran. No money moved. Check the capture route's log |
| `COMPLETED` with a row | Normal |
| `COMPLETED` with no row | Money was taken but not recorded. Look for `not recorded` in the log, and for webhook failures |

Read an order with the toolkit's `get_order`, or `GET /v2/checkout/orders/<id>`. Use the order id for fresh donations, because Transaction Search can run more than an hour behind.

### Known gaps

- **Refunds are not handled.** See above.
- **An unknown `/p/<slug>` returns HTTP 200.** The friendly message shows, but the 404 happens inside a streamed Suspense boundary, after the status has been sent.
- **The thank-you amount comes from the form,** not from the capture. The form can still be edited while the PayPal popup is open, so the message could show a different amount from the one paid. The ledger is unaffected.
- **Create order has no rate limit.** It is public and calls PayPal on every request.

## Setting up the webhook

PayPal has to reach the URL, so this only works on a deployed site, never on `localhost`.

1. At developer.paypal.com > Apps & Credentials, open the app and choose Add Webhook.
2. URL: `https://<your-service>.onrender.com/api/webhooks/paypal`. Event: `Payment capture completed`.
3. Copy the Webhook ID into `PAYPAL_WEBHOOK_ID` in the Render dashboard, and redeploy.

Without that ID, the route refuses every event with a 500, and PayPal keeps retrying for a while.

Check it worked in PayPal's Webhooks Events page, or in the Render log: a handled event logs `PayPal webhook <id>: order <id> recorded`, or `already-recorded` if the capture route got there first.

To see the webhook do the work alone, the capture route must not run, which takes a donor closing the tab at just the right moment. A simpler check of signatures and payload is that `already-recorded` line after any normal donation.

Signatures are checked by asking PayPal, through `/v1/notifications/verify-webhook-signature`. The dashboard's webhook simulator sends mock events that cannot pass that check, so test with a real donation.

## Rules for payouts

These come from the live results in [spike.md](spike.md), and `executeReimbursement` must follow them when it is built:

- **Only item status `SUCCESS` means paid.** A batch can reach `SUCCESS` with nothing delivered.
- **Treat `UNCLAIMED` as unresolved.** The ledger keeps that money reserved.
- **`sender_batch_id` comes from the claim id** through `senderBatchIdForClaim()`. Claim ids are random, so a demo reset cannot reuse one.
- **Payouts charge the sender a fee** on top of the amount.

Settlement took about 30 seconds in the one run measured.

## Rules for the Agent Toolkit

- Never use `ALL_TOOLS_ENABLED` in app code. It exposes tools that move money, such as `create_refund` and `pay_order`.
- Enable exactly `{ orders: { get: true }, transactions: { list: true } }`.
- Wrap each tool in `ai@7`'s `tool()`, or the model receives empty schemas. [spike.md](spike.md) has the code.
- Verifier check 6 is an agent step that uses only `get_order`, see [verifier.md](verifier.md). Strip payer details with `summariseOrder` before a model sees an order. Transaction Search can lag fresh donations by over 90 minutes, measured once in [spike.md](spike.md#donation-flow).
- Tools return JSON text, and report failures as `{ "ok": false }` without throwing.

## Current sandbox state

As of 2026-11-07:

- All 8 seeded orders read back from PayPal as `COMPLETED`, PHP 24,250.00 in total.
- Fees on those captures were PHP 944.50, around 3.4% + PHP 15 each.
- `/v1/reporting/balances` still reports PHP 5,000.00. That report did not change after an earlier payout either, so it may lag. A payout above PHP 5,000 has not been tried.
- A payout has never been delivered to a sandbox receiver. This is the next thing to prove, with `npm run spike -- payout`, which sends a real sandbox payout on every run.
