# Operations

## Deployment

1. Provision PostgreSQL 14+ with PostGIS 3. As a superuser create the database and run
   `CREATE EXTENSION postgis; CREATE EXTENSION pgcrypto;`. The application role needs no superuser rights.
2. Set environment variables (README › Environment variables). In production set `NODE_ENV=production`,
   `APP_ORIGIN=https://your.domain` and serve behind TLS (cookies are `Secure` in production).
3. `npm ci && npm run db:migrate && npm run geo:import && npm run build`.
4. Run `npm start` (web + realtime) and at least one `npm run worker`. Use a process manager (systemd,
   Kubernetes, etc.) with restart-on-failure. Both handle `SIGTERM` gracefully.
5. Reverse proxy: forward `/ws` with WebSocket upgrade headers (`Upgrade`, `Connection`) and keep
   `Host`/`Origin` intact. If the proxy sets `X-Forwarded-For`, set `TRUST_PROXY=1`.
6. Health: `GET /api/health` returns 200 when the database, PostGIS and geography are available and reports
   worker heartbeat age and overdue job count (alert if the worker is stale or overdue jobs grow).

Migrations are forward-only SQL files applied in order inside transactions and recorded in
`schema_migrations`. Run `npm run db:migrate` before starting new application versions.

## Backups

- `scripts/backup.sh [dir]` writes a compressed `pg_dump` custom-format file and keeps the last 48.
  Schedule it (e.g. hourly cron) and copy the files off-host. For point-in-time recovery use your provider's
  WAL archiving/PITR in addition.
- `scripts/restore.sh <dump> <target-url>` restores into an empty database that already has the extensions
  (verified: user, building, ledger counts and the zero-sum balance invariant match after a round trip).
- After restoring, run the ledger invariant check:
  `SELECT sum(balance) FROM accounts;` must be `0`.

## Limits (documented and enforced)

| Limit | Value | Where |
| --- | --- | --- |
| DB connections per process | `DB_POOL_MAX` (default 10) | `src/server/db.ts` |
| Statement timeout | 15 s | `src/server/db.ts` |
| Chunks per world request | 40 (~80 km² of parcels) | `MAX_CHUNKS_PER_REQUEST` |
| Buildings per chunk response | 2,000 | `MAX_BUILDINGS_PER_CHUNK` |
| Parcel overlay / buildings | only at zoom ≥ 14 / ≥ 13 | client |
| Client chunk cache | 240 chunks (LRU) | `src/client/game.ts` |
| Request body | 64 KB | `src/server/http.ts` |
| Rate limits (per user / IP, per minute) | auth 10, actions 120, reads 600 | `src/server/ratelimit.ts` |
| WebSocket subscriptions per connection | 200 channels; 5 connections per user; 16 KB messages | `src/server/realtime.ts` |
| Resync replay | 500 events, events kept 2 days | realtime, cleanup job |
| Parcels per player | 4 + 2 × level | `maxParcelsForLevel` |
| Open market orders per player | 50; order ≤ 1,000,000 units | `src/server/services/market.ts` |
| Settlement land | 60 parcels; members capped by tier (8/20/50/200) | settlements config |
| Offline accrual | capped at 24 h per tick | `src/server/services/simulation.ts` |

External services: OpenFreeMap tiles and AWS terrain tiles are fetched by browsers directly; if the style
cannot be loaded the client falls back to an offline style and the game layer keeps working.

## Scaling notes

- Web processes are horizontally scalable except for two in-memory pieces: the rate limiter (replace the
  `Map` with Redis or similar) and presence (per-instance; aggregate via Redis pub/sub if needed). Every
  instance runs its own `LISTEN` connection, so committed events reach clients on all instances.
- Workers scale horizontally (SKIP LOCKED). Recurring jobs are de-duplicated per time bucket.
- `world_events` and `jobs` are pruned by the cleanup job; for very high write volumes partition
  `world_events` by time.
- Load test (`scripts/loadtest.ts`, 100 concurrent players on one 4-vCPU container, pool of 20):
  ~168 ops/s; purchase p50 0.68 s, build p50 0.44 s, order p50 0.54 s, 12-chunk viewport p50 0.67 s with
  every player hitting the same area. Exactly one winner for a contested parcel; no negative inventories;
  money supply sum 0.

## Security

- Passwords: scrypt (N=16384, r=8, p=1) with per-user salt; constant-time comparison; dummy hash on unknown
  users to avoid username enumeration by timing.
- Sessions: 256-bit random tokens; only SHA-256 hashes stored; `HttpOnly`, `SameSite=Lax`, `Secure` in
  production; 30-day expiry; password change revokes other sessions; users can revoke other devices.
- CSRF: mutating endpoints and WebSocket upgrades require a matching `Origin`.
- Authorization: every service checks ownership/roles itself; settlement permissions are an explicit
  role→permission table (`src/shared/config/settlements.ts`). Leadership changes need the founder or a
  passed vote. Protected fields (balances, ownership, roles, ledger, configuration) have no direct write
  path from clients; the database is not reachable from browsers.
- Row Level Security: not used because no client connects to PostgreSQL directly (no Supabase/PostgREST).
  If you expose the database through Supabase or PostgREST, enable RLS on every table and deny writes to
  the tables listed above.
- Integrity: `CHECK` constraints on balances/quantities, unique partial indexes (one running production run
  per building, one pending invite), append-only triggers on `ledger_entries`, `votes`, `audit_log`.
- Audit log: registrations, password changes, settlement role/membership/governance/treasury actions,
  administrative grants. `POST /api/admin/grant` requires `users.is_admin = true` (set manually in SQL).
- Headers: `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`.
- Client bundles were scanned after `next build` for database URLs, password/token fields and webhook
  variables: none present.
