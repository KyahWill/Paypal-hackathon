# The verifier

`verifyClaim(claimId)` in `lib/verifier/verify-claim.ts` takes a claim from `SUBMITTED` to `APPROVED`, `REJECTED` or `ESCALATED`. It never pays. An approved claim waits for `executeReimbursement`, which is not built yet.

The model only reports what it read and whether the items fit. Code makes every decision about money.

## Order of checks

| Step | Check | Uses | On failure |
| --- | --- | --- | --- |
| 1 | `RECEIPT_PARSED` | Model, then code | Escalated, stops here |
| 2 | `WITHIN_PROJECT_WINDOW` | Code | Rejected, after step 4 |
| 3 | `WITHIN_BALANCE` | Code | Rejected, after step 4 |
| 4 | `NOT_DUPLICATE` | Code | Rejected |
| 5 | `ITEMS_SERVE_PURPOSE` | Model | Escalated |
| 6 | `POOL_CONFIRMED` | PayPal `get_order` | Escalated |
| 7 | Final balance re-check | Code, under a row lock | Rejected |

Steps 2 to 4 all run, so the page can show every problem at once. If two fail, the verdict is the first in this order: duplicate, window, balance. Checks that never ran are marked `SKIPPED`.

Each check row is written as it finishes, so a page can poll `VerificationCheck` to show progress live.

## Verdicts

| Verdict | When |
| --- | --- |
| `APPROVED` | Every check passed |
| `REJECTED_DUPLICATE` | Same image hash, or same vendor, date and total, as a claim that was not rejected |
| `REJECTED_OUTSIDE_WINDOW` | Purchase date is outside the project's dates. Both end dates count as inside |
| `REJECTED_OVER_BALANCE` | Amount is over the available balance, at either balance check |
| `ESCALATED_UNREADABLE_RECEIPT` | The model says it cannot read the receipt |
| `ESCALATED_EXTRACTION_FAILED` | The reading is incomplete or invalid, or in another currency |
| `ESCALATED_LOW_CONFIDENCE` | Confidence is under 0.8, or the line items do not add up to the total |
| `ESCALATED_ITEM_MISMATCH` | The items do not plausibly serve the project |
| `ESCALATED_LEDGER_MISMATCH` | PayPal disagrees with a donation in our ledger, or cannot find it |
| `ESCALATED_MODEL_ERROR` | The model call failed, or an unexpected system error happened |
| `ESCALATED_PAYPAL_ERROR` | PayPal could not be asked, so nothing is known either way |

## Rules to keep

- **Change claim state only through `transitionClaim`** in `lib/claims.ts`. It enforces the lifecycle and writes the audit row in the same transaction.
- **Never store provider error messages.** Evidence and audit notes keep the error name only, and PayPal evidence never includes payer details.
- **A model error is not a verdict on the receipt.** It escalates and never rejects.
- **Rejected claims do not count as duplicates,** or a charity could never resubmit.

## Pool confirmation

Check 6 calls the toolkit's `get_order` tool once per captured donation, from code, and compares the result in `compareOrder`. The model does not choose or see these calls, so it cannot talk the check into passing. The toolkit is built with only `orders.get` enabled.

`get_order` returns JSON text, and reports failures as `{ "ok": false }` without throwing. A 404 is a ledger mismatch. Anything else means we could not tell, so it is a PayPal error.

## Trying it locally

```bash
export DATABASE_URL=postgresql://<your-user>@localhost:5432/leslie_dev
npm run db:reset
npm run verify:receipt -- clean
```

The name can be `clean`, `overBalance`, `duplicate` or `unreadable`. It adds a claim each time, so run `npm run db:reset` between tries, or the clean receipt will count as a duplicate. It refuses to run on anything but a local database.

## What has been proven

| Part | Status |
| --- | --- |
| Checks, verdicts, lifecycle, audit rows | Tested against real Postgres |
| Two claims racing for the same money | Tested with forced overlap |
| `get_order` | Live: all 8 seeded orders confirmed. Wrong amount, wrong capture and fake order were all caught |
| Model outage | Live: the blocked key gives `ESCALATED_MODEL_ERROR` |
| Model reading and purpose calls | **Mock model only.** The Gemini key is blocked, so no real model has seen a receipt |

Until the key works, `npm run verify:receipt` stops at `ESCALATED_MODEL_ERROR` for every receipt. Once it does, run all four and compare them with [demo.md](demo.md). The prompts, the 0.8 confidence limit and the blurry receipt all need checking against real output.
