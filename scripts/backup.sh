#!/usr/bin/env bash
# Logical backup of the WORLDSTATE database (custom format, compressed).
# Usage: scripts/backup.sh [output-dir]   (uses $DATABASE_URL)
# Schedule it (e.g. cron hourly) and copy files off-host; test restores regularly with scripts/restore.sh.
set -euo pipefail
URL="${DATABASE_URL:?DATABASE_URL not set}"
OUT="${1:-./backups}"
mkdir -p "$OUT"
FILE="$OUT/worldstate-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --no-owner --compress=6 --file="$FILE" "$URL"
echo "backup written: $FILE ($(du -h "$FILE" | cut -f1))"
# Keep the 48 most recent backups in this directory.
ls -1t "$OUT"/worldstate-*.dump 2>/dev/null | tail -n +49 | xargs -r rm --
