# WORLDSTATE

A persistent, multiplayer, browser-based civilization game on the real Earth. Players register, buy
virtual land on a global parcel grid, construct stylised 3D buildings, run production businesses,
trade on a player marketplace, research technologies and found settlements with shared projects and
votes. The world is shared by every account and keeps running (production, income, order expiry,
vote deadlines) while players are offline.

> Land and currency in WORLDSTATE are entirely virtual. Owning a parcel grants no real-world rights.

- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Implementation status (completed / tested / incomplete / blocked): [docs/STATUS.md](docs/STATUS.md)
- Operations (limits, deployment, backups, scaling, security): [docs/OPERATIONS.md](docs/OPERATIONS.md)
- **Free hosting on Supabase + Render: [docs/DEPLOY.md](docs/DEPLOY.md)**

## Stack

Next.js 15 (App Router) + React 19 + TypeScript + Tailwind CSS 4 · MapLibre GL JS 5 (globe + Web Mercator)
· Three.js (custom MapLibre layer, instanced low-poly models) · PostgreSQL 16 + PostGIS 3 · `ws` WebSocket
gateway fed by a transactional outbox (`LISTEN/NOTIFY`) · durable PostgreSQL job queue worker · Zod
validation · Vitest integration tests against a real database · Playwright end-to-end tests.

Authentication is self-hosted (scrypt password hashes, opaque session tokens stored as SHA-256 hashes,
`HttpOnly` `SameSite=Lax` cookies). Supabase was not used because no Supabase project or credentials were
available; the database is never exposed to browsers, so all authorization is enforced in server code
plus database constraints and triggers (see OPERATIONS.md › Security).

## Quick start (local)

Requirements: Node.js 20+ (22 recommended), PostgreSQL 14+ with PostGIS 3, `psql`/`pg_dump` client tools.

```bash
# 1. Database (as a PostgreSQL superuser, once)
createuser worldstate --pwprompt --createdb
createdb -O worldstate worldstate
createdb -O worldstate worldstate_test
for db in worldstate worldstate_test; do
  psql -d $db -c 'CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS pgcrypto;'
done

# 2. App
cp .env.example .env            # adjust DATABASE_URL etc.
npm install
npm run db:migrate              # applies db/migrations/*.sql
npm run geo:import              # downloads Natural Earth land/lakes/urban polygons (~45 MB) into PostGIS

# 3. Run (two processes)
npm run dev                     # web app + realtime gateway on http://localhost:3000
npm run worker                  # background simulation worker (required for production runs, income, votes)
```

Open http://localhost:3000, create an account, pick a region in the **World** panel, zoom to street level,
select an available parcel, buy it, then use **Build** to place a structure.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Development server (Next.js + `/ws` realtime gateway) via `server/index.ts` |
| `npm run build` / `npm start` | Production build / production server |
| `npm run worker` | Durable job worker (run one or more instances) |
| `npm run db:migrate` | Apply SQL migrations (`-- --test` for the test DB) |
| `npm run geo:import` | Import Natural Earth geography (`-- --test` for the test DB) |
| `npm run bootstrap` | Migrate and import geography if missing (used on hosted start-up) |
| `npm test` | Vitest unit + integration + concurrency + realtime tests (uses `TEST_DATABASE_URL`) |
| `npm run test:e2e` | Playwright browser tests against a running **dev** server + worker (they read the dev-only `window.__worldstate` store) |
| `npm run typecheck` | TypeScript check |
| `npx tsx scripts/loadtest.ts 100` | Concurrency/load test with 100 simulated players (test DB) |
| `scripts/backup.sh [dir]` / `scripts/restore.sh <dump> <url>` | Backups (see OPERATIONS.md) |
| `scripts/reset-db.sh <url>` | Drop all WORLDSTATE tables (development only) |

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string (PostGIS + pgcrypto extensions must exist). Server-only. |
| `TEST_DATABASE_URL` | tests | Separate database used by `npm test`; its game tables are truncated by tests. |
| `APP_ORIGIN` | prod | Public origin, e.g. `https://worldstate.example.com`. Mutating requests and WebSocket upgrades must carry this `Origin` (or match the `Host`). |
| `PORT`, `HOST` | no | Listen port/host (default `3000`, `0.0.0.0`). |
| `DB_POOL_MAX` | no | Max DB connections per process (default 10). |
| `RUN_WORKER` | no | `1` runs the background worker inside the web process (single-service hosting such as Render free). |
| `DATABASE_CA_CERT` | no | PEM CA certificate to verify the database TLS certificate (e.g. Supabase CA). Without it, TLS is used without CA verification when the URL has `sslmode=require` or points at Supabase. |
| `COOKIE_SECURE` | no | `1` forces `Secure` cookies; automatic when `NODE_ENV=production` (set `0` to disable). |
| `TRUST_PROXY` | no | `1` to trust `X-Forwarded-For` for client IPs (only behind your own proxy). |
| `LOG_LEVEL` | no | `debug` / `info` (default) / `warn` / `error`. Logs are JSON lines on stdout/stderr. |
| `ERROR_WEBHOOK_URL` | no | Errors are POSTed as JSON to this URL (hook for Sentry/Slack/etc.). |
| `DISABLE_RATE_LIMIT` | no | `1` disables rate limiting (tests only). |
| `NEXT_PUBLIC_MAP_STYLE` | no | MapLibre style URL (default OpenFreeMap `liberty`, restyled). `local` = offline fallback style. Inlined at build time. |
| `NEXT_PUBLIC_TERRAIN_TILES` | no | Terrarium-encoded raster-dem URL template for hillshading (default AWS Terrain Tiles). `off` disables. |
| `PLAYWRIGHT_CHROMIUM_PATH`, `E2E_BASE_URL` | e2e | Chromium binary and app URL for Playwright. |

No secret is exposed to the browser: only `NEXT_PUBLIC_*` values (public tile URLs) reach client bundles.

## Data sources and licences

- Base map: © OpenStreetMap contributors (ODbL), vector tiles served by OpenFreeMap; restyled at runtime.
- Land/lake/urban classification: Natural Earth 1:10m (public domain), imported into PostGIS.
- Hillshade: Mapzen/Tilezen Terrain Tiles on AWS Open Data (various open licences, attribution shown).
- 3D buildings: procedural low-poly models defined in `src/shared/config/buildings.ts` (no third-party assets).

## Project layout

```
server/            custom HTTP server (Next + /ws) and worker entry points
db/migrations/     SQL migrations (schema, constraints, triggers, seed system accounts)
scripts/           migrate, geo import, load test, backup/restore, reset
src/shared/        code shared by client and server: grid, geometry, schemas, game configuration
src/server/        db, auth, ledger, outbox events, jobs, realtime gateway, domain services
src/app/           Next.js pages and API route handlers
src/client/        game client: state store, realtime client, MapLibre + Three.js world, UI panels
tests/             Vitest integration tests (real PostgreSQL/PostGIS)
e2e/               Playwright browser tests
```
