#!/usr/bin/env bash
#
# scripts/backup-db.sh — hot online backup of runs.db
#
# Uses `sqlite3 .backup` which performs a consistent snapshot under
# WAL without blocking writers. Output filename is ISO-8601 UTC so
# alphabetical sort matches chronological order.
#
# Retention: 7 most recent. Older backups are deleted; no manual
# rotation needed.
#
# Idempotent + safe to run from cron:
#   * Creates the backups dir if absent
#   * Exits non-zero if sqlite3 binary is missing
#   * Exits non-zero if the source DB is missing
#   * Atomic: writes to a .tmp file first, mv into place on success
#
# Environment:
#   DATA_DIR   - root data directory (default: /data)
#
# Cron example (hourly at :17):
#   17 * * * * /opt/snowcrewai/scripts/backup-db.sh \
#       >> /data/backups/backup.log 2>&1
#
# See docs/OPERATIONS.md section 3 for backup + restore procedure.

set -euo pipefail

DATA_DIR="${DATA_DIR:-/data}"
SOURCE_DB="${DATA_DIR}/crew-studio/runs.db"
BACKUP_DIR="${DATA_DIR}/backups"
RETENTION_COUNT=7

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "[backup-db] FATAL: sqlite3 binary not found on PATH" >&2
  exit 1
fi

if [ ! -f "$SOURCE_DB" ]; then
  echo "[backup-db] FATAL: source DB missing at $SOURCE_DB" >&2
  exit 2
fi

mkdir -p "$BACKUP_DIR"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="${BACKUP_DIR}/runs-${TS}.db"
TARGET_TMP="${TARGET}.tmp"

echo "[backup-db] taking online backup: $SOURCE_DB -> $TARGET"
# Use `.backup` (not file copy) so we get a consistent snapshot even if
# WAL has uncheckpointed transactions in flight.
sqlite3 "$SOURCE_DB" ".backup '$TARGET_TMP'"
mv -f "$TARGET_TMP" "$TARGET"

# Retention sweep: keep the N newest, delete older ones.
# `ls -t` orders by mtime newest-first; tail strips off the keepers.
DELETED=0
# shellcheck disable=SC2012  # ls is fine here; filenames are tightly controlled
while IFS= read -r OLD; do
  [ -z "$OLD" ] && continue
  rm -f -- "$BACKUP_DIR/$OLD"
  DELETED=$((DELETED + 1))
done < <(ls -1t "$BACKUP_DIR" 2>/dev/null | grep -E '^runs-.*\.db$' | tail -n +$((RETENTION_COUNT + 1)))

SIZE="$(wc -c < "$TARGET" 2>/dev/null || echo 0)"
echo "[backup-db] ok: ${TARGET} (${SIZE} bytes); pruned ${DELETED} older snapshot(s); retained ${RETENTION_COUNT}"
