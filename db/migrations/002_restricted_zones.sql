-- Default restricted zones: polar regions are not available for settlement.
INSERT INTO restricted_zones (name, reason, geom) VALUES
  ('Antarctic Treaty Area', 'Protected polar region', ST_MakeEnvelope(-180, -90, 180, -60, 4326)),
  ('High Arctic', 'Protected polar region', ST_MakeEnvelope(-180, 80, 180, 90, 4326));
