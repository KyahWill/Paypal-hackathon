# Leslie

Leslie is an AI reimbursement agent for small charities, built for the PayPal AI Hackathon.

Donors give to a specific charity project. The charity spends first, then files a claim by chatting with Leslie and uploading a receipt. A verifier agent checks the receipt against the project's donated pool. Approved claims are paid to the charity's PayPal account automatically, and anything the system cannot process safely goes to a human admin.

> **PayPal sandbox only.** No real money moves. The charity, school, stores and people in the demo data are all fictional.

## How it works

1. A donor gives through PayPal on the project's page. The money joins that project's pool.
2. The charity treasurer buys what the project needs, then uploads the receipt in a chat with Leslie.
3. The verifier checks that the receipt is readable, the amount fits the pool, the date is inside the project window, the items serve the project, it is not a duplicate, and the donations are confirmed in PayPal.
4. If everything passes, the claim is paid through PayPal Payouts. If a check fails, the claim is rejected or escalated to an admin.

The model never moves money. Only `executeReimbursement(claimId)` calls Payouts, and it re-runs the checks first. See [CLAUDE.md](CLAUDE.md) for the full rules.

## Project status

| Area | Status |
| --- | --- |
| Database schema, ledger, audit log | Done |
| Seed data, demo receipts, real sandbox captures | Done |
| Render blueprint and health check | Done, first live deploy still to confirm |
| Donation page, capture and webhook | Done locally, webhook not yet proven live |
| Login and sessions | Password hashing only |
| Verifier | Built and tested, real Gemini calls unproven while the key is blocked |
| Leslie chat | Not built |
| Payouts client and `executeReimbursement` | Not built |
| Admin escalation queue | Not built |

## Stack

Next.js and TypeScript, Postgres on Neon through Prisma, Gemini through the Vercel AI SDK, and PayPal Orders v2, Agent Toolkit and Payouts. Deployed on Render.

## Quick start

You need Node 24, a local Postgres and PayPal sandbox credentials. [docs/setup.md](docs/setup.md) has the details.

```bash
git clone https://github.com/KyahWill/Paypal-hackathon.git
cd Paypal-hackathon
npm install
cp .env.example .env        # then fill it in

createdb leslie_dev
createdb leslie_test

# Set DATABASE_URL in .env to your local database first. db:reset wipes it.
npm run db:reset
npm run dev -- -p 3032
```

Open http://localhost:3032. The health check is at http://localhost:3032/api/health.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev -- -p 3032` | Starts the dev server |
| `npm test` | Runs the tests against `leslie_test` |
| `npm run typecheck` | Type checks the project |
| `npm run lint` | Runs ESLint |
| `npm run db:reset` | **Wipes `DATABASE_URL`**, applies migrations and reseeds |
| `npm run donations:capture` | Creates real sandbox captures for the seed data |
| `npm run receipts:render` | Re-renders the demo receipts with local Chrome |
| `npm run verify:receipt -- clean` | Runs a demo receipt through the verifier, local databases only |
| `npm run spike` | Re-runs the API checks, and sends a real sandbox payout |

## Documentation

Everything else lives in [docs/](docs/README.md):

- [Local setup](docs/setup.md)
- [Database, seed and ledger](docs/database.md)
- [PayPal sandbox](docs/paypal-sandbox.md)
- [The verifier](docs/verifier.md)
- [Deploying to Render](docs/deploy.md)
- [Running the demo](docs/demo.md)
- [Troubleshooting](docs/troubleshooting.md)
- [API spike findings](docs/spike.md)
