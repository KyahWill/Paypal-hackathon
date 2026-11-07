# The verifier

`verifyClaim(claimId, deps, onProgress)` in `lib/verifier/verify-claim.ts` takes a claim from `SUBMITTED` to `APPROVED`, `REJECTED` or `ESCALATED`. It never pays. An approved claim waits for `executeReimbursement`, which is not built yet.

The model reports what it read, scores whether the items fit, and makes the PayPal lookups. Code makes every decision about money.

## Order of checks

| Step | Check | Uses | On failure |
| --- | --- | --- | --- |
| 1 | `RECEIPT_PARSED` | Model, then code | Escalated, stops here |
| 2 | `WITHIN_PROJECT_WINDOW` | Code | Rejected, after step 4 |
| 3 | `WITHIN_BALANCE` | Code | Rejected, after step 4 |
| 4 | `NOT_DUPLICATE` | Code | Rejected |
| 5 | `ITEMS_SERVE_PURPOSE` | Model | Escalated |
| 6 | `POOL_CONFIRMED` | Agent with PayPal `get_order`, then code | Escalated |
| 7 | Final balance re-check | Code, under a row lock | Rejected |

Steps 2 to 4 all run, so the page can show every problem at once. If two fail, the verdict is the first in this order: duplicate, window, balance. Checks that never ran are marked `SKIPPED`.

## Progress events

Pass `onProgress` to hear about each step as it happens. `lib/verifier/events.ts` has the types:

| Event | When |
| --- | --- |
| `run_started` | The run exists. `checks` lists the checks in display order |
| `check_started` | A check is about to run |
| `check_finished` | Its status and evidence. Checks that never ran arrive as `SKIPPED` |
| `verdict` | The claim's new state has been saved |

Each event fires after its database write commits, so a page never shows something that is not saved. A listener that fails is logged and ignored. If a page reloads mid-run, read the `VerificationCheck` rows, which hold the same evidence.

## Verdicts

| Verdict | When |
| --- | --- |
| `APPROVED` | Every check passed |
| `REJECTED_DUPLICATE` | Same image hash, or same vendor, date and total, as a claim that was not rejected |
| `REJECTED_OUTSIDE_WINDOW` | Purchase date is outside the project's dates. Both end dates count as inside |
| `REJECTED_OVER_BALANCE` | Amount is over the available balance, at either balance check |
| `ESCALATED_UNREADABLE_RECEIPT` | The model says it cannot read the receipt |
| `ESCALATED_EXTRACTION_FAILED` | The reading is incomplete or invalid, or in another currency |
| `ESCALATED_LOW_CONFIDENCE` | Confidence is under 0.7, or the line items do not add up to the total |
| `ESCALATED_ITEM_MISMATCH` | The purpose score is under 0.7 |
| `ESCALATED_LEDGER_MISMATCH` | PayPal disagrees with a donation in our ledger, or cannot find it |
| `ESCALATED_MODEL_ERROR` | A model call failed twice or timed out twice, or an unexpected system error happened |
| `ESCALATED_PAYPAL_ERROR` | PayPal could not be asked, so nothing is known either way |

## Rules to keep

- **Change claim state only through `transitionClaim`** in `lib/claims.ts`. It enforces the lifecycle and writes the audit row in the same transaction.
- **Never store provider error messages.** Evidence and audit notes keep the error name only, and PayPal evidence never includes payer details.
- **A model error is not a verdict on the receipt.** It escalates and never rejects.
- **Rejected claims do not count as duplicates,** or a charity could never resubmit.
- **Every model call gets exactly two attempts,** through `withOneRetry`, with `maxRetries: 0` so the SDK's own retries do not multiply them. Each attempt has its own 60 second timeout, so a run can take about 6 minutes at worst. Allow for that in any route that calls it.
- **A reply that fails the schema is retried too.** After the second try, a bad reading is `ESCALATED_EXTRACTION_FAILED`, and a bad purpose score is `ESCALATED_MODEL_ERROR`.

## Pool confirmation

Check 6 in `lib/verifier/pool-agent.ts` is an agent step: Gemini is given the project's order ids and calls `get_order` for each. The toolkit is built with only `orders.get` enabled, and that is the model's only tool.

The agent does the lookups, but it does not decide:

- **The verdict comes from `compareOrder`,** run by code on the raw PayPal reply the tool wrapper recorded. Whatever the model says afterwards is ignored.
- **Skipped orders are looked up by code,** so skipping cannot pass the check. Evidence shows `agentLookups` and `codeLookups`. A high `codeLookups` means the prompt needs work.
- **The tool refuses ids that are not in the ledger,** without calling PayPal.
- **The model sees only status and capture id, status and amount,** from `summariseOrder`. Payer names and emails never go to Google.

`get_order` returns JSON text, and reports failures as `{ "ok": false }` without throwing. A 404 is a ledger mismatch. Anything else means we could not tell, so it is a PayPal error. If the model fails twice, the claim is `ESCALATED_MODEL_ERROR`, with no fallback to code alone, so a Gemini outage stops every claim here too.

`list_transactions` is not used, because Transaction Search can run over 90 minutes behind.

## Trying it locally

```bash
export DATABASE_URL=postgresql://<your-user>@localhost:5432/leslie_dev
npm run db:reset
npm run verify:receipt -- all
```

`all` runs the four receipts in order, prints each check as it finishes, and exits with an error if a verdict is not the expected one. You can also name one: `clean`, `overBalance`, `duplicate` or `unreadable`. Each run adds claims, so run `npm run db:reset` between tries, or the clean receipt will count as a duplicate. It refuses to run on anything but a local database.

It uses the real Gemini and PayPal sandbox, and the seeded donations. It never pays.

## What has been proven

| Part | Status |
| --- | --- |
| Checks, verdicts, lifecycle, audit rows | Tested against real Postgres |
| Two claims racing for the same money | Tested with forced overlap |
| The four seed images | Real bytes through the real code, in `tests/seed-receipts.test.ts`. The model's answers are scripted, so this proves the pipeline, not Gemini's reading |
| `get_order` | Live: all 8 seeded orders confirmed. Wrong amount, wrong capture and fake order were all caught |
| Pool agent's lookups | Live PayPal with a scripted model: 8 of 8 confirmed, including one order the model skipped. The payer's email was in PayPal's reply and not in what the model was sent |
| Model outage | Live: the blocked key gives `ESCALATED_MODEL_ERROR` on all four receipts |
| Model reading, purpose score and the agent's tool calls | **Mock model only.** The Gemini key is blocked, so no real model has seen a receipt or called a tool |

Until the key works, `npm run verify:receipt` stops at `ESCALATED_MODEL_ERROR` for every receipt. Once it does, run `all`. The prompts, both 0.7 limits, the blurry receipt and whether Gemini really makes one call per order all need checking against real output.
