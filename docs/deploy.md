# Deploying to Render

`render.yaml` defines one Free web service in Singapore, next to the Neon database.

## First deploy

1. Push this repo to GitHub.
2. In Render: New > Blueprint, pick the repo, and fill in the values it asks for. Copy them from `.env`. Use the direct (non-pooled) Neon string for `DATABASE_URL`. Leave `APP_URL` as a placeholder until Render gives you the URL, then set it and redeploy.
3. Each build runs `prisma migrate deploy`, then seeds only if the database has no projects.
4. Check `https://<your-service>.onrender.com/api/health`. It returns `{"status":"ok"}` once the app can reach the database.

If the database already has tables that did not come from these migrations, `prisma migrate deploy` stops with P3005 and the deploy fails without changing anything.

## Resetting the demo

The Free plan has no shell, so a reset goes through a deploy:

1. Copy the full commit hash that is currently deployed (`git rev-parse HEAD`).
2. Set `DEMO_RESET_COMMIT` to it in the Render dashboard, then Manual Deploy > Deploy latest commit.

This wipes every table and reseeds. It only fires for that exact commit, so a leftover value cannot wipe the demo on the next push. Deploying that same commit again does reset again, so clear the variable afterwards.

## Before a live demo

Free services spin down after 15 minutes without traffic and take about a minute to wake. Open the site a few minutes before presenting.
