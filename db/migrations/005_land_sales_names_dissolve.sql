-- Parcel names, player-to-player land listings, and settlement dissolution.

ALTER TABLE parcels ADD COLUMN name text CHECK (name IS NULL OR length(name) BETWEEN 1 AND 40);
UPDATE parcels SET name = 'Parcel ' || id WHERE owner_user_id IS NOT NULL;
UPDATE parcels p SET name = left(s.name || ' land', 40) FROM settlements s WHERE p.settlement_id = s.id;

-- One open listing per parcel. The listing is removed whenever the parcel changes hands.
CREATE TABLE parcel_listings (
  parcel_id      text PRIMARY KEY REFERENCES parcels(id) ON DELETE CASCADE,
  seller_user_id uuid NOT NULL REFERENCES users(id),
  price          bigint NOT NULL CHECK (price > 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX parcel_listings_seller ON parcel_listings (seller_user_id);
CREATE INDEX parcel_listings_created ON parcel_listings (created_at DESC);
ALTER TABLE parcel_listings ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE 'REVOKE ALL ON parcel_listings FROM anon'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE 'REVOKE ALL ON parcel_listings FROM authenticated'; END IF;
END $$;

-- Dissolved settlements are kept (their treasury account is referenced by the ledger) but hidden.
ALTER TABLE settlements ADD COLUMN dissolved_at timestamptz;
DROP INDEX settlements_name_lower;
CREATE UNIQUE INDEX settlements_name_lower ON settlements (lower(name)) WHERE dissolved_at IS NULL;
