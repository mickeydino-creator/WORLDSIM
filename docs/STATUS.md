# Implementation status

Snapshot of what is built, how it was verified, and what is missing. "Automated" means covered by the
Vitest integration suite (66 tests against real PostgreSQL/PostGIS, `npm test`) and/or the Playwright
suite (6 browser tests, `npm run test:e2e`). "Verified manually" means exercised in a real browser
(headless Chromium with WebGL via SwiftShader) with screenshots, but without an automated assertion.

## Completed and tested (automated)

**First playable loop (E2E):** register → enter the world → fly to a region → select an available parcel →
buy it → place a building with the keyboard placement controls → reload → same building and ownership →
a second account in another browser sees the same parcel owner and building → the first player builds
again and the second player receives it in realtime without reloading.

**Authentication & sessions:** registration (validation, duplicate rejection), login, logout, wrong
password, forged session cookie rejected, cross-origin mutation rejected, unauthenticated API/page access
rejected/redirected, password change revokes other sessions.

**Land:** real-world land classification (Natural Earth land/lakes/urban + restricted polar zones), server-
computed price (land class × local demand), purchase with atomic debit + ownership + history + ledger entry,
client price ignored (max-price guard only), already-owned / water / restricted / insufficient funds
rejections, 8 simultaneous buyers → exactly one winner, idempotent replay never double-charges, parcel cap
by level, build permissions granted by owners.

**Construction:** placement inside owned parcel, cost + resources charged, persistence across reload,
overlap rejection, adjacent placement allowed, out-of-bounds rejection, other player's land forbidden
unless permitted, level/research/land-class/settlement-zoning requirements, unknown type and malformed
input rejected, upgrade, demolish with refund, concurrent overlapping placements → one succeeds.

**Economy:** immutable double-entry ledger; zero-sum and per-account balance invariants asserted after
every economic test; production consumes inputs and operating cost at start and delivers outputs from the
durable worker (not early), replayed completion is a no-op, replayed start request does not double-consume,
inputs required (no negative inventory), cancellation refunds inputs, research-gated recipes, auto-repeat
continues while offline, building rent accrues exactly once per elapsed minute under concurrent ticks.

**Marketplace:** escrowed order book (goods for sells, credits for buys), price-time matching at the maker's
price with buyer price improvement refunded, seller fee, cancel returns escrow (owner only), concurrent
takers cannot oversell, concurrent buy orders cannot overspend, worker expires orders and releases escrow,
self-trading prevented, UI order form validation and placement (E2E).

**Research & progression:** tech prerequisites, RP costs, research unlocks real buildings/recipes,
specialization (free first choice, RP cost to change, real modifiers), XP/levels, achievements.

**Settlements:** founding (level and funds requirement, treasury seeded, founding parcel becomes settlement
land), invitations and acceptance, role-based permissions (members cannot invite/remove/promote; treasurer
cannot appoint leaders; founder can), member removal by rank, parcel donation, settlement-land zoning,
projects with player and treasury contributions (clamped to need), project completion creates a persistent
settlement-owned building, cancellation refunds all contributors, proposals with snapshot of eligible
voters, duplicate votes rejected, outsiders rejected, quorum and approval rules, server-time deadlines
finalised by the worker, passed treasury transfers executed, votes immutable.

**Realtime:** WebSocket auth by session cookie + Origin, private channels protected, committed changes
broadcast to subscribers of the chunk, rolled-back changes never broadcast, observers' balances unaffected
by events, missed events replayed after reconnect, presence per chunk, removed settlement members stop
receiving settlement events.

**Interface (E2E):** every navigation panel opens without page errors and shows real data (wallet 50,000 CR,
inventory, ledger "starting grant", research points), locked actions are disabled with a reason.

**Admin:** administrative credit grant restricted to admins, ledgered and audit-logged.

**Grid/geometry/config:** parcel ids round-trip; 5,000 random and edge-snapped points always fall inside
their parcel/chunk; chunks are disjoint; rotated footprints; catalog/recipe/research consistency.

**Operations:** load test (100 concurrent players: ~168 ops/s, single contested-parcel winner, no negative
inventory, zero-sum money); production build; client bundles scanned for secrets (none); backup → restore
round trip verified (row counts and ledger match).

## Completed, verified manually (no automated assertion)

- Stylised world: restyled OSM basemap, Natural Earth relief at global zoom, terrarium hillshade, globe
  projection with atmosphere at low zoom transitioning to Mercator; offline fallback style.
- Three.js buildings: procedural low-poly models for all 23 building types, instanced rendering,
  distance/zoom LOD, ownership plates, producing indicators, selection outline, placement ghost with
  valid/invalid tint, mouse + keyboard placement and rotation.
- Parcel overlay colouring: available / yours / other owner / your settlement / other settlement / restricted.
- Small-screen layout (390 px wide): bottom navigation, bottom sheet panel.
- Settlement, research, profile, settings and notification panels in the browser (their APIs are tested).
- Structured JSON logs, `/api/health` (database, PostGIS, geography, worker heartbeat, overdue jobs).

## Incomplete / not implemented

- **Labour simulation and staffing** (marked optional in the spec): businesses have owners, status,
  production rules, operating costs and market orders, but no employees. Business inventory is pooled in
  the owner's storage rather than per building.
- **Settlement land purchases from the treasury**: settlements gain land by founding grant or member
  donation only.
- **Terrain-aware 3D**: terrain is rendered as hillshading; there is no elevation-displaced 3D terrain mesh
  and buildings sit on a flat plane. Forest/mountain land classes are not derived (no server-side
  land-cover/elevation dataset); classes are land, coastal, urban, water, restricted.
- Real-world OSM buildings are displayed as basemap footprints but do not block game placement.
- Buildings cannot span multiple parcels (largest footprint 60 × 44 m fits in a ~111 m parcel).
- Rate limiting and presence are in-memory per web instance (documented; needs Redis for multi-instance).
- No automated rendering-performance (FPS) or visual-regression tests; no formal accessibility audit
  (keyboard placement, labels and focus styles are implemented).
- E2E coverage of settlement UI flows (backend fully tested, UI exercised manually only).
- Global map search/geocoding (curated region list + free navigation instead).

## Blocked (needs external credentials or decisions)

- **Supabase Auth / Row Level Security**: no Supabase project or keys were available. Replaced with
  self-hosted authentication; RLS is unnecessary because browsers never reach the database (see
  OPERATIONS.md › Security for what to enable if the DB is ever exposed).
- **Email verification and password reset**: require an email provider (SMTP/API credentials).
- **Error monitoring service**: a generic `ERROR_WEBHOOK_URL` hook exists; no Sentry/other DSN provided.
- **Live deployment**: a free Supabase + Render setup is prepared and verified locally (fresh-database
  bootstrap, RLS lockdown of Supabase's `anon`/`authenticated` roles, TLS connection, in-process worker in a
  production build) — see DEPLOY.md. Creating the Supabase project and Render service requires the owner's
  accounts. Off-site backup storage still needs storage credentials.
