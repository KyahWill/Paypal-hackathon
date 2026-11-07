# Database, seed and ledger

## Models

| Model | Holds |
| --- | --- |
| `User` | Logins. Role is `TREASURER` or `ADMIN`. Donors have no account |
| `Charity` | Name and payout email |
| `Project` | Slug, story, purpose, start and end dates, goal, currency |
| `Donation` | PayPal order id, capture id, amount, status, first name. Written only once a capture is `COMPLETED` |
| `Claim` | State, amount, verdict code |
| `Receipt` | Image bytes, sha256, extracted JSON. One per claim |
| `VerificationRun` | One verifier pass over a claim |
| `VerificationCheck` | One row per check with its evidence and status, so the UI can show progress live |
| `Payout` | Batch id, item id, status. One per claim |
| `AuditLog` | Claim state history. Append-only |

Money is always an integer in minor units with an explicit currency, so PHP 39.15 is stored as `3915`.

## Things the schema enforces

- **A claim can only have one payout.** `Payout.claimId` and `senderBatchId` are unique, and the batch id comes from `senderBatchIdForClaim()`.
- **`AuditLog` cannot be edited.** A database trigger rejects UPDATE and DELETE. Only TRUNCATE gets through, on purpose, so `db:reset` can work.
- **`Receipt.sha256` is not unique, on purpose.** A duplicate upload must be stored so that it can be rejected.
- **`Claim.amountMinor` can be null,** because an unreadable receipt may never produce an amount.

A rejected claim is resubmitted as a new claim.

## Changing the schema

1. Edit `prisma/schema.prisma`.
2. With `DATABASE_URL` pointing at `leslie_dev`, create a migration:

   ```bash
   npx prisma migrate dev --name describe_the_change
   ```

3. Run `npm test`. The tests apply new migrations automatically.
4. Commit the migration folder. Render applies it on the next deploy with `prisma migrate deploy`.

Never edit a migration that has already reached Neon. Add a new one.

Triggers are not tracked by Prisma, so hand-written SQL needs its own migration, like `20261107000100_audit_log_append_only`.

## Seeding

`npm run db:reset` runs `prisma migrate deploy`, then `prisma/seed.ts`. The seed:

1. Checks that every donation has a real sandbox capture, before it touches anything.
2. Truncates every table.
3. Creates the charity, project, two users, eight donations and one paid claim.

The story lives in `seed/data.ts`, which also feeds the receipt renderer, so images and rows always agree. Real PayPal ids live in `seed/sandbox-donations.json`.

| Seeded total | PHP |
| --- | --- |
| Captured donations | 24,250.00 |
| Past paid claim | 5,988.00 |
| Available | 18,262.00 |

Donation dates are story dates from August to October. PayPal shows the real capture date, so the verifier must compare ids, status and amount, never dates.

The past paid claim's payout uses `SEED-` ids that do not exist in PayPal. Nothing should look those up.

## Changing the receipts

1. Edit `seed/data.ts`.
2. Run `npm run receipts:render`. It uses local Chrome, or set `CHROME_PATH`.
3. Look at the images, then run `npm test`. The tests keep the clean receipt under the pool and the over-balance receipt above it.
4. Commit the PNGs and run `npm run db:reset`, because the seed stores the duplicate receipt's image and hash.

## How the available balance works

`getAvailableBalance(projectId)` in `lib/ledger.ts` returns captured donations minus paid and in-flight claims.

| Claim | Effect on the balance |
| --- | --- |
| `PAID` | Subtracted |
| `APPROVED`, `PAYING` | Subtracted as in-flight |
| `SUBMITTED`, `VERIFYING`, `REJECTED` | Not subtracted |
| `ESCALATED` before any payout | Not subtracted |
| `ESCALATED` with a payout | Subtracted, unless the item is `FAILED`, `RETURNED`, `REFUNDED` or `REVERSED` |

The last row stops a retry from spending the same money twice while a payout is `UNCLAIMED` or on hold.

- Inside a transaction, pass `{ db: tx }`.
- When re-checking a claim, pass `{ excludeClaimId }` so it does not count against itself.
- A negative result is shown as it is, because it means something went wrong.
- Mixed currencies throw an error.

**Known gap:** the ledger uses gross amounts. PayPal took PHP 944.50 in fees on the seeded donations, and Payouts charge a fee too, so a claim for nearly the full balance could leave the real account short.
