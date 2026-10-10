#!/usr/bin/env bash
# Restores a backup produced by scripts/backup.sh into an EMPTY database in which a superuser has
# already run: CREATE EXTENSION postgis; CREATE EXTENSION pgcrypto;
# Usage: scripts/restore.sh <file.dump> <target-database-url>
set -euo pipefail
FILE="${1:?backup file required}"
TARGET="${2:?target database url required}"
LIST="$(mktemp)"
trap 'rm -f "$LIST"' EXIT
# Skip extension objects and PostGIS's own spatial_ref_sys data (owned by the extension in the target).
pg_restore --list "$FILE" | grep -vE ' EXTENSION | COMMENT - EXTENSION |TABLE DATA public spatial_ref_sys ' > "$LIST"
pg_restore --no-owner --exit-on-error --use-list="$LIST" --dbname="$TARGET" "$FILE"
echo "restored $FILE into $TARGET"
