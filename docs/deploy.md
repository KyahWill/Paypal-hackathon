# Deploying to Render

`render.yaml` defines one Free web service in Singapore, next to the Neon database. The region cannot be changed after the service is created.

## What happens on each deploy

```
npm ci
npx prisma migrate deploy
npm run db:seed-on-deploy
npm run build
npm start
```

These run in the build command because the Free plan has no pre-deploy command, shell or one-off jobs. If any step fails, the deploy fails and the previous version keeps running. A migration that already ran stays applied, though.

`db:seed-on-deploy` seeds only if the database has no projects, so a normal redeploy never wipes data.

## First deploy

1. In Render: New > Blueprint, then connect `KyahWill/Paypal-hackathon`. It deploys from `main` and redeploys on every push to it.
2. Fill in the values it asks for:

   | Variable | Note |
   | --- | --- |
   | `DATABASE_URL` | The direct Neon string, not the `-pooler` one. Migrations need it |
   | `APP_URL` | Use a placeholder until Render gives you the URL |
   | `SEED_*` | This site is public, so use strong passwords here |
   | `PAYPAL_WEBHOOK_ID` | Leave empty for now. You need the Render URL first, see [paypal-sandbox.md](paypal-sandbox.md#setting-up-the-webhook) |
   | `PAYPAL_CHARITY_RECEIVER_EMAIL` | The sandbox Personal account. Set it now, because the seed copies it onto the charity |
   | The rest | Copy from `.env` |

   `CURRENCY` and `SESSION_SECRET` are set by the blueprint.

3. Once the first deploy is live, set `APP_URL` to the real URL, register the webhook, set `PAYPAL_WEBHOOK_ID`, and redeploy.
4. Open `https://<your-service>.onrender.com/api/health`. It returns `{"status":"ok"}` when the app can reach the database, and a 503 when it cannot.

Neon must be empty, or hold only these migrations. Otherwise `prisma migrate deploy` stops with P3005 and changes nothing.

## Everyday deploys

Merging to `main` deploys automatically. New migrations are applied in the build.

Changing an environment variable in Render does not change data that is already seeded. If the value went into the seed, such as the receiver email or a seeded password, reset the demo too.

## Resetting the demo

1. Copy the full commit hash that is deployed: `git rev-parse origin/main`.
2. Set `DEMO_RESET_COMMIT` to it in the Render dashboard.
3. Choose Manual Deploy > Deploy latest commit.
4. Clear `DEMO_RESET_COMMIT` when it finishes.

This wipes every table and reseeds. It fires only when the value matches the commit being deployed, so a leftover value cannot wipe the demo on the next push. Deploying that same commit again would reset again, which is why step 4 matters.

From a network that can reach Neon on port 5432, this also works, and is quicker:

```bash
DATABASE_URL='<direct neon string>' npm run db:reset
```

## Free plan limits

- The service sleeps after 15 minutes without traffic, and takes about a minute to wake.
- Render may restart a Free service at any time, and files on disk do not survive. Receipts are stored in Postgres, so this is safe.
- There are 750 free instance hours per workspace each month.
