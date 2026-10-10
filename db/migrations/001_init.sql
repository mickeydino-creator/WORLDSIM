-- WORLDSTATE initial schema.
-- Coordinates: WGS84 longitude/latitude (EPSG:4326). Distances computed via geography casts.
-- Money: bigint minor units (1 credit = 100 minor units). Never floating point.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Identity & sessions
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL CHECK (username ~ '^[A-Za-z0-9_]{3,24}$'),
  email         text NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  password_hash text NOT NULL,
  display_name  text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 40),
  is_admin      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_lower ON users (lower(username));
CREATE UNIQUE INDEX users_email_lower ON users (lower(email));

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent   text,
  ip           text
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expires ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Player progression
-- ---------------------------------------------------------------------------
CREATE TABLE players (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  xp               bigint NOT NULL DEFAULT 0 CHECK (xp >= 0),
  level            int NOT NULL DEFAULT 1 CHECK (level >= 1),
  reputation       bigint NOT NULL DEFAULT 0,
  research_points  bigint NOT NULL DEFAULT 0 CHECK (research_points >= 0),
  specialization   text,
  home_lng         double precision,
  home_lat         double precision,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE player_research (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tech_id     text NOT NULL,
  unlocked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tech_id)
);

CREATE TABLE player_achievements (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_id text NOT NULL,
  unlocked_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, achievement_id)
);

-- ---------------------------------------------------------------------------
-- Settlements (declared early: accounts and parcels reference them)
-- ---------------------------------------------------------------------------
CREATE TABLE settlements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL CHECK (length(name) BETWEEN 3 AND 40),
  description     text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  founder_user_id uuid NOT NULL REFERENCES users(id),
  center          geometry(Point, 4326) NOT NULL,
  governance      jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX settlements_name_lower ON settlements (lower(name));
CREATE INDEX settlements_center ON settlements USING gist (center);

CREATE TABLE settlement_members (
  settlement_id uuid NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE, -- one settlement per player
  role          text NOT NULL CHECK (role IN ('founder','leader','treasurer','infrastructure_manager','member')),
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (settlement_id, user_id)
);

CREATE TABLE settlement_invites (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id   uuid NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  invitee_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by      uuid NOT NULL REFERENCES users(id),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','revoked')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  responded_at    timestamptz
);
CREATE UNIQUE INDEX settlement_invites_pending ON settlement_invites (settlement_id, invitee_user_id) WHERE status = 'pending';

CREATE TABLE settlement_activity (
  id            bigserial PRIMARY KEY,
  settlement_id uuid NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id),
  type          text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX settlement_activity_settlement ON settlement_activity (settlement_id, id DESC);

-- ---------------------------------------------------------------------------
-- Currency: accounts + immutable double-entry ledger
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           text NOT NULL CHECK (kind IN ('player','settlement','system')),
  user_id        uuid UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  settlement_id  uuid UNIQUE REFERENCES settlements(id) ON DELETE RESTRICT,
  system_code    text UNIQUE,
  balance        bigint NOT NULL DEFAULT 0,
  allow_negative boolean NOT NULL DEFAULT false,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (allow_negative OR balance >= 0),
  CHECK (
    (kind = 'player' AND user_id IS NOT NULL AND settlement_id IS NULL AND system_code IS NULL) OR
    (kind = 'settlement' AND settlement_id IS NOT NULL AND user_id IS NULL AND system_code IS NULL) OR
    (kind = 'system' AND system_code IS NOT NULL AND user_id IS NULL AND settlement_id IS NULL)
  )
);

-- System accounts. "mint" is the only account allowed to go negative: its balance is
-- minus the total currency ever issued, so SUM(balance) over all accounts is always 0.
INSERT INTO accounts (kind, system_code, allow_negative) VALUES
  ('system', 'mint', true),
  ('system', 'land_office', false),
  ('system', 'construction', false),
  ('system', 'operations', false),
  ('system', 'market_escrow', false),
  ('system', 'market_fees', false);

CREATE TABLE ledger_entries (
  id                bigserial PRIMARY KEY,
  tx_type           text NOT NULL,
  from_account      uuid NOT NULL REFERENCES accounts(id),
  to_account        uuid NOT NULL REFERENCES accounts(id),
  amount            bigint NOT NULL CHECK (amount > 0),
  idempotency_key   text NOT NULL UNIQUE,
  actor_user_id     uuid REFERENCES users(id),
  parcel_id         text,
  building_id       uuid,
  order_id          uuid,
  trade_id          uuid,
  project_id        uuid,
  settlement_id     uuid,
  production_run_id uuid,
  metadata          jsonb NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (from_account <> to_account)
);
CREATE INDEX ledger_from ON ledger_entries (from_account, id DESC);
CREATE INDEX ledger_to ON ledger_entries (to_account, id DESC);

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Request-level idempotency. A row is written inside the same transaction as the action,
-- so a key only exists if the action committed.
CREATE TABLE idempotency_keys (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key           text NOT NULL CHECK (length(key) BETWEEN 8 AND 100),
  scope         text NOT NULL,
  request_hash  text NOT NULL,
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- ---------------------------------------------------------------------------
-- Geography reference data (imported by scripts/import-geo.ts, Natural Earth, public domain)
-- ---------------------------------------------------------------------------
CREATE TABLE geo_features (
  id    bigserial PRIMARY KEY,
  layer text NOT NULL CHECK (layer IN ('land','lake','urban')),
  geom  geometry(Geometry, 4326) NOT NULL
);
CREATE INDEX geo_features_geom ON geo_features USING gist (geom);
CREATE INDEX geo_features_layer ON geo_features (layer);

CREATE TABLE restricted_zones (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  reason     text NOT NULL,
  geom       geometry(Geometry, 4326) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX restricted_zones_geom ON restricted_zones USING gist (geom);

-- Cached land classification per chunk (see src/shared/grid.ts).
CREATE TABLE parcel_surveys (
  chunk_key   text PRIMARY KEY,
  cells       jsonb NOT NULL,  -- { "<parcelId>": "<landClass>" }
  geo_version int NOT NULL,
  surveyed_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Land parcels. Rows are materialised the first time a grid cell changes hands.
-- ---------------------------------------------------------------------------
CREATE TABLE parcels (
  id             text PRIMARY KEY CHECK (id ~ '^[0-9]+_[0-9]+$'),
  row_idx        int NOT NULL,
  col_idx        int NOT NULL,
  chunk_key      text NOT NULL,
  geom           geometry(Polygon, 4326) NOT NULL,
  centroid       geometry(Point, 4326) NOT NULL,
  land_class     text NOT NULL CHECK (land_class IN ('land','coastal','urban','water','restricted')),
  owner_user_id  uuid REFERENCES users(id),
  settlement_id  uuid REFERENCES settlements(id),
  last_price     bigint CHECK (last_price >= 0),
  zoning         jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT (owner_user_id IS NOT NULL AND settlement_id IS NOT NULL))
);
CREATE INDEX parcels_geom ON parcels USING gist (geom);
CREATE INDEX parcels_centroid ON parcels USING gist (centroid);
CREATE INDEX parcels_chunk ON parcels (chunk_key);
CREATE INDEX parcels_owner ON parcels (owner_user_id) WHERE owner_user_id IS NOT NULL;
CREATE INDEX parcels_settlement ON parcels (settlement_id) WHERE settlement_id IS NOT NULL;

CREATE TABLE parcel_ownership_history (
  id                 bigserial PRIMARY KEY,
  parcel_id          text NOT NULL REFERENCES parcels(id),
  from_user_id       uuid REFERENCES users(id),
  to_user_id         uuid REFERENCES users(id),
  from_settlement_id uuid REFERENCES settlements(id),
  to_settlement_id   uuid REFERENCES settlements(id),
  price              bigint NOT NULL DEFAULT 0,
  reason             text NOT NULL,
  ledger_entry_id    bigint REFERENCES ledger_entries(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX parcel_history_parcel ON parcel_ownership_history (parcel_id, id DESC);

CREATE TABLE parcel_permissions (
  parcel_id       text NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
  grantee_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (parcel_id, grantee_user_id)
);

-- ---------------------------------------------------------------------------
-- Buildings
-- ---------------------------------------------------------------------------
CREATE TABLE buildings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type          text NOT NULL,
  owner_user_id uuid REFERENCES users(id),
  settlement_id uuid REFERENCES settlements(id),
  built_by      uuid NOT NULL REFERENCES users(id),
  parcel_id     text NOT NULL REFERENCES parcels(id),
  chunk_key     text NOT NULL,
  position      geometry(Point, 4326) NOT NULL,
  rotation_deg  real NOT NULL CHECK (rotation_deg >= 0 AND rotation_deg < 360),
  footprint     geometry(Polygon, 4326) NOT NULL,
  level         int NOT NULL DEFAULT 1 CHECK (level >= 1),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','idle','producing')),
  recipe_id     text,
  auto_repeat   boolean NOT NULL DEFAULT false,
  income_at     timestamptz NOT NULL DEFAULT now(), -- simulation accrual watermark
  accrual_carry jsonb NOT NULL DEFAULT '{}',        -- fractional income/RP/reputation carried between ticks
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_user_id IS NULL) <> (settlement_id IS NULL))
);
CREATE INDEX buildings_footprint ON buildings USING gist (footprint);
CREATE INDEX buildings_chunk ON buildings (chunk_key);
CREATE INDEX buildings_parcel ON buildings (parcel_id);
CREATE INDEX buildings_owner ON buildings (owner_user_id);
CREATE INDEX buildings_settlement ON buildings (settlement_id);
CREATE INDEX buildings_income ON buildings (income_at);

-- ---------------------------------------------------------------------------
-- Inventory & production
-- ---------------------------------------------------------------------------
CREATE TABLE inventories (
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource text NOT NULL,
  quantity bigint NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  PRIMARY KEY (user_id, resource)
);

CREATE TABLE production_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id   uuid NOT NULL,  -- no FK: run history outlives demolished buildings
  owner_user_id uuid NOT NULL REFERENCES users(id),
  recipe_id     text NOT NULL,
  inputs        jsonb NOT NULL,
  outputs       jsonb NOT NULL,
  currency_out  bigint NOT NULL DEFAULT 0,
  status        text NOT NULL CHECK (status IN ('running','completed','cancelled')),
  started_at    timestamptz NOT NULL DEFAULT now(),
  completes_at  timestamptz NOT NULL,
  completed_at  timestamptz
);
CREATE UNIQUE INDEX production_one_running ON production_runs (building_id) WHERE status = 'running';
CREATE INDEX production_owner ON production_runs (owner_user_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- Marketplace (escrowed order book)
-- ---------------------------------------------------------------------------
CREATE TABLE market_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id),
  side            text NOT NULL CHECK (side IN ('buy','sell')),
  resource        text NOT NULL,
  price_per_unit  bigint NOT NULL CHECK (price_per_unit > 0),
  quantity        bigint NOT NULL CHECK (quantity > 0),
  remaining       bigint NOT NULL CHECK (remaining >= 0),
  escrow_currency bigint NOT NULL DEFAULT 0 CHECK (escrow_currency >= 0),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','filled','cancelled','expired')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  CHECK (remaining <= quantity)
);
CREATE INDEX market_book ON market_orders (resource, side, price_per_unit, created_at) WHERE status = 'open';
CREATE INDEX market_user ON market_orders (user_id, created_at DESC);
CREATE INDEX market_expiry ON market_orders (expires_at) WHERE status = 'open';

CREATE TABLE trades (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buy_order_id   uuid NOT NULL REFERENCES market_orders(id),
  sell_order_id  uuid NOT NULL REFERENCES market_orders(id),
  buyer_user_id  uuid NOT NULL REFERENCES users(id),
  seller_user_id uuid NOT NULL REFERENCES users(id),
  resource       text NOT NULL,
  quantity       bigint NOT NULL CHECK (quantity > 0),
  price_per_unit bigint NOT NULL CHECK (price_per_unit > 0),
  total          bigint NOT NULL CHECK (total > 0),
  fee            bigint NOT NULL CHECK (fee >= 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trades_resource ON trades (resource, created_at DESC);
CREATE INDEX trades_buyer ON trades (buyer_user_id, created_at DESC);
CREATE INDEX trades_seller ON trades (seller_user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Settlement projects & governance
-- ---------------------------------------------------------------------------
CREATE TABLE settlement_projects (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id       uuid NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  type                text NOT NULL,
  name                text NOT NULL CHECK (length(name) BETWEEN 3 AND 60),
  parcel_id           text REFERENCES parcels(id),
  position            geometry(Point, 4326),
  rotation_deg        real NOT NULL DEFAULT 0,
  target_building_id  uuid REFERENCES buildings(id) ON DELETE SET NULL,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled','blocked')),
  cost_currency       bigint NOT NULL CHECK (cost_currency >= 0),
  funded_currency     bigint NOT NULL DEFAULT 0 CHECK (funded_currency >= 0),
  required_resources  jsonb NOT NULL DEFAULT '{}',
  funded_resources    jsonb NOT NULL DEFAULT '{}',
  proposed_by         uuid NOT NULL REFERENCES users(id),
  result_building_id  uuid REFERENCES buildings(id) ON DELETE SET NULL,
  status_note         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  CHECK (funded_currency <= cost_currency)
);
CREATE INDEX settlement_projects_settlement ON settlement_projects (settlement_id, created_at DESC);

CREATE TABLE project_contributions (
  id              bigserial PRIMARY KEY,
  project_id      uuid NOT NULL REFERENCES settlement_projects(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id),
  source          text NOT NULL CHECK (source IN ('player','treasury')),
  kind            text NOT NULL CHECK (kind IN ('currency','resource')),
  resource        text,
  amount          bigint NOT NULL CHECK (amount > 0),
  ledger_entry_id bigint REFERENCES ledger_entries(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_contributions_project ON project_contributions (project_id, id DESC);

CREATE TABLE proposals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id   uuid NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN ('treasury_transfer','role_change','remove_member','governance_change')),
  title           text NOT NULL CHECK (length(title) BETWEEN 3 AND 80),
  payload         jsonb NOT NULL,
  proposed_by     uuid NOT NULL REFERENCES users(id),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','passed','rejected','executed','failed')),
  eligible_voters uuid[] NOT NULL,
  quorum_pct      int NOT NULL CHECK (quorum_pct BETWEEN 1 AND 100),
  approval_pct    int NOT NULL CHECK (approval_pct BETWEEN 1 AND 100),
  opens_at        timestamptz NOT NULL DEFAULT now(),
  closes_at       timestamptz NOT NULL,
  result          jsonb,
  finalized_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (closes_at > opens_at)
);
CREATE INDEX proposals_settlement ON proposals (settlement_id, created_at DESC);
CREATE INDEX proposals_open ON proposals (closes_at) WHERE status = 'open';

CREATE TABLE votes (
  proposal_id uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  choice      text NOT NULL CHECK (choice IN ('yes','no','abstain')),
  cast_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id, user_id)
);
CREATE TRIGGER votes_immutable BEFORE UPDATE OR DELETE ON votes
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- Outbox events (realtime), notifications, jobs, audit
-- ---------------------------------------------------------------------------
CREATE TABLE world_events (
  id         bigserial PRIMARY KEY,
  channel    text NOT NULL,
  type       text NOT NULL,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX world_events_channel ON world_events (channel, id);
CREATE INDEX world_events_created ON world_events (created_at);

CREATE TABLE notifications (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL DEFAULT '',
  payload    jsonb NOT NULL DEFAULT '{}',
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user ON notifications (user_id, id DESC);

CREATE TABLE jobs (
  id           bigserial PRIMARY KEY,
  type         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  dedupe_key   text UNIQUE,
  run_at       timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  attempts     int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 8,
  locked_until timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_due ON jobs (run_at) WHERE status IN ('pending','running');

CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id),
  action        text NOT NULL,
  target_type   text,
  target_id     text,
  details       jsonb NOT NULL DEFAULT '{}',
  ip            text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created ON audit_log (created_at DESC);
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE system_status (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
