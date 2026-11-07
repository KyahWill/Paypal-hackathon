# Troubleshooting

## Database

**Commands hang when connecting to Neon.** Port 5432 is probably blocked on your network. Check with:

```bash
nc -z -G 5 <your-neon-host> 5432
```

If a ZTNA or company network is blocking it, ask whoever runs it for an exception. Do not tunnel around it. Use local Postgres in the meantime, and let Render talk to Neon. Its traffic does not pass through your machine.

**`P3005` on deploy.** Neon already has tables that did not come from these migrations. Nothing changed. Look at what is there before deciding whether to clear it.

**`P1010: User was denied access`.** The connection string has no username. Use `postgresql://<your-user>@localhost:5432/leslie_dev`.

**`Donation 1 (...) has no matching sandbox capture`.** `seed/data.ts` and `seed/sandbox-donations.json` disagree. Nothing was wiped. See [paypal-sandbox.md](paypal-sandbox.md).

**`Seed data is in PHP, but CURRENCY is ...`.** Set `CURRENCY=PHP`.

**`Refusing to run tests`.** `TEST_DATABASE_URL` must point at a database whose name ends in `_test`, so tests can never wipe real data.

**Tests fail to connect.** Run `createdb leslie_test` and check that Postgres is running with `pg_isready`.

**`AuditLog is append-only`.** This is working as designed. Add a new row rather than changing one.

**`prisma migrate reset` is refused.** Prisma may block it for AI agents. Use `npm run db:reset`.

## PayPal

| You see | It means | Do this |
| --- | --- | --- |
| Item `UNCLAIMED`, `RECEIVER_UNREGISTERED` | The receiver is not a sandbox account | Set `PAYPAL_CHARITY_RECEIVER_EMAIL` to a sandbox Personal account, then reset the demo |
| `INSUFFICIENT_FUNDS` | The sender has too little in that currency | Check the balance. Sandbox held PHP only, with USD at 0.00 |
| `PAYER_CANNOT_PAY` | Card-funded orders are refused on this account | Use `npm run donations:capture` |
| Batch `SUCCESS` but no money arrived | Batch status is not delivery | Read the item's `transaction_status` |
| Balance did not change after a payment | The balance report may lag | Do not rely on it being instantly current |

## Gemini

**`403 API_KEY_SERVICE_BLOCKED`.** The key's restrictions block `generativelanguage.googleapis.com`. Remove the restriction in Google Cloud, or create a new key in Google AI Studio. Then run `npm run spike -- vision`. This was still happening on 2026-11-07, so the configured `GEMINI_MODEL` is unconfirmed too.

**The SDK cannot find the key.** The variable must be `GOOGLE_GENERATIVE_AI_API_KEY`, not `GEMINI_API_KEY`.

## Render

**`/api/health` returns 503.** The app is up but cannot reach the database. Check `DATABASE_URL` in Render. The log shows only an error name, on purpose, so that connection details stay out of it.

**The first request takes about a minute.** The Free plan was asleep.

**The new receiver email or password did not apply.** Those are stored by the seed, so reset the demo.

## Rotating a secret

The repository is public, so treat anything pasted into a commit, issue or chat log as exposed.

1. Create the new value at the provider. Neon: reset the role's password. PayPal: Apps & Credentials. Gemini: Google AI Studio.
2. Update `.env` and the Render dashboard.
3. Redeploy on Render, then revoke the old value.
4. If it was committed, rotating it is the fix. Removing it from history is not enough.
