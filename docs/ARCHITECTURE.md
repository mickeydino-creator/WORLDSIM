# WORLDSTATE architecture

## Processes

```
browser ──HTTP──▶ server/index.ts ──▶ Next.js route handlers ──▶ domain services ──▶ PostgreSQL + PostGIS
   ▲                    │                                               │ (one transaction per action:
   │                    └──/ws──▶ RealtimeHub ◀── LISTEN ───────────────┘  state + ledger + outbox row + pg_notify)
   └──── committed events ◀──┘
                                    server/worker.ts ──▶ job queue (jobs table, SKIP LOCKED) ──▶ same services
```

- **Web** (`server/index.ts`): one Node process serving Next.js pages, the REST API (`src/app/api/**`) and
  the WebSocket gateway at `/ws`. Stateless apart from in-memory rate-limit counters and WebSocket sessions.
- **Worker** (`server/worker.ts`): claims due jobs from the `jobs` table and runs them. Any number of
  workers may run; jobs are claimed with `FOR UPDATE SKIP LOCKED` and each job's effects commit in the same
  transaction that marks it done.
- **PostgreSQL + PostGIS**: the single source of truth for every piece of game state.

## Server-authoritative actions

Every mutating endpoint is wrapped by `actionRoute` (`src/server/http.ts`), which:

1. rejects cross-origin requests (`Origin` must match `APP_ORIGIN`/`Host`) — CSRF protection on top of `SameSite=Lax`;
2. authenticates the session cookie (`sessions.token_hash`), applies per-user rate limits;
3. validates the JSON body with the shared Zod schema (`src/shared/schemas.ts`);
4. opens one transaction, inserts the `Idempotency-Key` row (`idempotency_keys`), runs the domain service,
   stores the response, and commits. A replayed request returns the stored response; a concurrent duplicate
   blocks on the key's unique index and then replays. Failed actions roll back, so the key is reusable.

Domain services (`src/server/services/*`) never trust client prices, balances, owners or statuses. They
lock the rows they decide on (`SELECT … FOR UPDATE`, conditional `UPDATE … WHERE quantity >= $n`,
advisory locks for order books) and rely on constraints (`CHECK (balance >= 0)`, `CHECK (quantity >= 0)`,
unique partial indexes) as a final guard.

## Currency ledger

`accounts` holds balances for players, settlement treasuries and system accounts (`mint`, `land_office`,
`construction`, `operations`, `market_escrow`, `market_fees`, `project_escrow`). Every credit movement is a
single row in `ledger_entries` (`src/server/ledger.ts › transfer`) written in the same transaction as the
balance updates, with a globally unique idempotency key and references to the parcel/building/order/trade/
project involved. `ledger_entries`, `votes` and `audit_log` are append-only (triggers reject UPDATE/DELETE/
TRUNCATE). Only `mint` may go negative, so `SUM(accounts.balance) = 0` at all times and each account's
balance equals its ledger flows — both invariants are asserted by the test suite.

## World model

- **Coordinates**: WGS84 longitude/latitude (EPSG:4326) in the database; Web Mercator for rendering.
- **Parcel grid** (`src/shared/grid.ts`): rows of 0.001° latitude, each row split into an integer number of
  columns so cells are ~111 m × ~111 m at every latitude. Parcel id = `<row>_<col>`. The same pure function
  derives a parcel's polygon on client and server.
- **Chunks**: 0.02° × 0.02° boxes (~2 km). The unit of loading, caching, survey and realtime subscription.
- **Land survey**: the first time a chunk is requested, every cell is classified from Natural Earth polygons in
  PostGIS (`land`, `coastal`, `urban`, `water`, `restricted` — restricted zones come from `restricted_zones`)
  and cached in `parcel_surveys`. Concurrent requests for the same chunk share one computation.
- **Parcels** are materialised as rows (`parcels`, PostGIS polygon + centroid, GiST-indexed) the first time
  they change hands; ownership history is kept in `parcel_ownership_history`.
- **Buildings** store position, rotation, and footprint polygon (GiST). Placement validates the footprint with
  `ST_CoveredBy(parcel)` and checks overlaps with `ST_Relate(…, 'T********')` (interiors intersect; touching
  edges are allowed) while holding the parcel row lock, which serialises placements on that parcel.

## Simulation and background jobs

| Job | Trigger | Effect |
| --- | --- | --- |
| `production.complete` | scheduled at run completion | deliver outputs/credits, RP, XP, achievements, optional auto-repeat |
| `world.tick` | every 30 s | accrue building rent / research / reputation per elapsed minute (watermark `income_at` + fractional carry) |
| `market.expire` | every 60 s | expire orders, release escrow |
| `proposal.finalize` | at the vote deadline | tally and execute settlement proposals |
| `proposal.sweep` | every 60 s | safety net for overdue proposals |
| `maintenance.cleanup` | hourly | expired sessions, old jobs/events/idempotency keys |

Recurring jobs are de-duplicated by time bucket (`dedupe_key`), so multiple workers do not multiply them.
All handlers are idempotent: they act only on rows still in the expected state, under a row lock.

## Realtime

Services call `publish()` (`src/server/events.ts`) which inserts into `world_events` and issues
`pg_notify` inside the business transaction; PostgreSQL delivers notifications only on COMMIT, so clients
never see rolled-back changes. `RealtimeHub` (`src/server/realtime.ts`) holds one `LISTEN` connection,
fetches event rows by id and forwards them to WebSockets subscribed to the channel:

- `chunk:<key>` — parcel ownership and building changes (any authenticated player, validated key);
- `user:<id>` — wallet, inventory, production, notifications (only that user);
- `settlement:<id>` — settlement activity (members only);
- `market:<resource>` — order book changes; `global`.

Messages are notifications of committed state; they never grant anything. On reconnect the client sends
`resync` with its last event id and the gateway replays up to 500 missed events (else asks the client to
refetch). Presence (who is looking at which chunk, online count) is transient and kept only in memory.

## Client

- `src/client/game.ts`: store with authoritative server data (player, chunk cache with LRU eviction, selection,
  placement); realtime events patch the cache.
- `src/client/world/WorldMap.tsx`: MapLibre globe (low zoom) → Mercator (local zoom); restyled OSM basemap
  plus Natural Earth relief and terrarium hillshade; streams chunks for the viewport (max 40 per request),
  draws the parcel overlay as GeoJSON fill/line layers, handles selection and placement (mouse or keyboard).
- `src/client/world/buildingsLayer.ts`: Three.js custom layer. Geometry per model part is cached; each
  `(type, part)` is one `InstancedMesh`. LOD: detailed models within 2.5 km at zoom ≥ 15, coloured blocks
  otherwise; nothing below zoom 13 or while the globe projection is active. Floating origin for precision.
- `src/client/ui/*`: World, Build, Economy (wallet, inventory, businesses, market, ledger), Settlements
  (membership, roles, treasury, land, projects, governance), Research, Profile, Settings panels.

## Configuration-driven gameplay

All content lives in `src/shared/config/`: `buildings.ts` (catalog with costs, requirements, effects and 3D
model parts), `recipes.ts`, `resources.ts`, `land.ts` (land classes and price formula), `research.ts` (tech
tree, specializations, modifiers), `progression.ts` (XP, levels, achievements), `settlements.ts` (roles,
permissions, project types, governance rules, tiers). Services interpret this data generically; adding a
building or recipe is a config change (the config test suite checks consistency).
