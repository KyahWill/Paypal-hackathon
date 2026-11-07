# Local setup

## You will need

- Node 24
- Postgres running locally (tested on 14)
- A PayPal developer account with a sandbox app, see [paypal-sandbox.md](paypal-sandbox.md)
- A Gemini API key from Google AI Studio
- Google Chrome, only if you re-render the receipts

## 1. Install

```bash
git clone https://github.com/KyahWill/Paypal-hackathon.git
cd Paypal-hackathon
npm install
```

`npm install` also generates the Prisma client into `app/generated/prisma`, which is not committed.

## 2. Create the local databases

```bash
createdb leslie_dev
createdb leslie_test
```

`leslie_dev` is for running the app. `leslie_test` is wiped by the tests.

## 3. Fill in `.env`

```bash
cp .env.example .env
```

| Variable | Where it comes from |
| --- | --- |
| `APP_URL` | `http://localhost:3032` locally |
| `SESSION_SECRET` | `openssl rand -base64 32` |
| `CURRENCY` | `PHP`. The seed refuses anything else, because the receipts are in pesos |
| `DATABASE_URL` | Local: `postgresql://<your-user>@localhost:5432/leslie_dev`. Neon: the direct connection string |
| `TEST_DATABASE_URL` | Optional. Defaults to local `leslie_test`. The name must end in `_test` |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | Your choice. Used to create the admin login |
| `SEED_TREASURER_EMAIL`, `SEED_TREASURER_PASSWORD` | Your choice. Used to create the treasurer login |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google AI Studio. The SDK needs this exact name |
| `GEMINI_MODEL` | A model name your key can use. It is never hardcoded |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | developer.paypal.com > Apps & Credentials, sandbox mode |
| `NEXT_PUBLIC_PAYPAL_CLIENT_ID` | Same value as `PAYPAL_CLIENT_ID`. This one reaches the browser |
| `PAYPAL_CHARITY_RECEIVER_EMAIL` | A sandbox Personal account email, not a real address |
| `PAYPAL_WEBHOOK_ID` | Leave empty locally. Only a deployed site can receive webhooks, see [paypal-sandbox.md](paypal-sandbox.md#setting-up-the-webhook) |

To point a single command at another database without editing `.env`, set the variable inline. It wins over the file:

```bash
DATABASE_URL=postgresql://<your-user>@localhost:5432/leslie_dev npm run db:reset
```

## 4. Seed the database

```bash
npm run db:reset
```

**This wipes whatever `DATABASE_URL` points at.** Check that value first, especially if `.env` holds your Neon string.

You should see `8 donations, 1 paid claim, PHP 18262.00 available`.

## 5. Run it

```bash
npm run dev -- -p 3032
```

`npm run dev` on its own uses port 3000, which will not match `APP_URL`.

## 6. Check your work

```bash
npm run typecheck
npm run lint
npm test
```

Run all three before calling a phase done. Tests use a real Postgres and create their schema automatically. They refuse to run on a database whose name does not end in `_test`.

## Working style

Work in small steps and commit after each one that works. Render deploys from `main`, so use a branch and merge when it is ready.
