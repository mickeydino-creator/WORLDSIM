# Free deployment: Supabase (database) + Render (app)

Cost: $0. Everything runs on the free tiers: one Supabase project and one Render web service.
The background worker runs inside the web service (`RUN_WORKER=1`) because Render's free tier has
no background workers.

## 1. Supabase: create the database (about 3 minutes)

1. https://supabase.com/dashboard → **New project**. Pick a region close to your Render region and set a
   strong database password (save it).
2. **Database → Extensions**: search for `postgis` and enable it (schema `public` or `extensions` both work).
3. Click **Connect** (top of the project page) → **Session pooler** → copy the URI. It looks like
   `postgresql://postgres.<project-ref>:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres`.
   Replace `[YOUR-PASSWORD]` with your database password.
   - Use the **Session pooler** (port 5432), not the Transaction pooler (6543): realtime uses `LISTEN/NOTIFY`.
   - Use the pooler rather than the "direct connection", which is IPv6-only and not reachable from Render.

You do not need to create tables: the app migrates the schema and imports the world geography (~35 MB)
automatically on first start.

## 2. Render: deploy the app (about 5 minutes + first build)

1. https://dashboard.render.com → **New → Blueprint** → connect GitHub and choose this repository and the
   branch you want to deploy. Render reads `render.yaml`.
2. When asked for `DATABASE_URL`, paste the Supabase Session pooler URI from step 1.
3. **Apply**. The first build takes a few minutes; the first start imports geography (about a minute).
4. Open `https://<service-name>.onrender.com` and create an account.

`APP_ORIGIN` is set automatically from Render's `RENDER_EXTERNAL_URL`. If you add a custom domain, set
`APP_ORIGIN=https://your.domain` in the service's environment.

## What the free tiers mean in practice

- **Render free web services sleep after ~15 minutes without traffic** and take ~30-60 s to wake on the
  next visit. While asleep the simulation pauses; on wake-up it catches up: finished production runs are
  completed, building income accrues for the elapsed time (capped at 24 h), expired orders and closed votes
  are processed. No progress is lost, it is just applied late.
- **Supabase free projects pause after a week of inactivity**; resume them from the dashboard.
  Free database size is 500 MB (WORLDSTATE uses ~50 MB empty).
- Free instances have 512 MB RAM and shared CPU: fine for testing with friends, not for many concurrent players.
- For always-on operation, move to a paid Render instance and set `RUN_WORKER=0` with a separate worker
  service running `npm run worker`.

## Security notes for Supabase

- Migration `004_row_level_security.sql` enables Row Level Security on every WORLDSTATE table and revokes
  all privileges from Supabase's `anon` and `authenticated` roles, so the auto-generated Supabase REST API
  cannot read or modify game data. The app connects as the table owner, which bypasses RLS.
  Any future migration that adds a table must also `ENABLE ROW LEVEL SECURITY` on it.
- Do not use or publish the Supabase `service_role` key; WORLDSTATE does not need it.
- Connections use TLS. Supabase uses its own certificate authority, so by default the certificate is not
  verified against a CA (equivalent to libpq `sslmode=require`). To verify it, download the CA certificate
  from **Project Settings → Database → SSL Configuration** and set its PEM contents as `DATABASE_CA_CERT`.

## Troubleshooting

- `/api/health` shows the database, geography and worker status.
- `ENOTFOUND`/timeouts connecting to the database: you used the direct connection string; use the Session pooler.
- `type "geometry" does not exist`: PostGIS is not enabled (step 1.2).
- Render logs show `bootstrap complete` followed by `WORLDSTATE listening` when startup succeeded.
