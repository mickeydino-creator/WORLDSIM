#!/usr/bin/env bash
# Development helper: drops and recreates all WORLDSTATE tables in the given database (default: $DATABASE_URL).
set -euo pipefail
URL="${1:-${DATABASE_URL:?DATABASE_URL not set}}"
psql "$URL" -v ON_ERROR_STOP=1 -q <<'SQL'
SET client_min_messages = warning;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('spatial_ref_sys') LOOP
    EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', r.tablename);
  END LOOP;
  DROP FUNCTION IF EXISTS forbid_mutation() CASCADE;
END $$;
SQL
echo "dropped all tables in $URL"
