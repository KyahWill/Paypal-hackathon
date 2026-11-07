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
- Verifier check 6 uses `get_order`, see [verifier.md](verifier.md). Transaction Search may lag behind fresh donations, though that has not been measured.
- Tools return JSON text, and report failures as `{ "ok": false }` without throwing.

## Current sandbox state

As of 2026-11-07:

- All 8 seeded orders read back from PayPal as `COMPLETED`, PHP 24,250.00 in total.
- Fees on those captures were PHP 944.50, around 3.4% + PHP 15 each.
- `/v1/reporting/balances` still reports PHP 5,000.00. That report did not change after an earlier payout either, so it may lag. A payout above PHP 5,000 has not been tried.
- A payout has never been delivered to a sandbox receiver. This is the next thing to prove, with `npm run spike -- payout`, which sends a real sandbox payout on every run.
