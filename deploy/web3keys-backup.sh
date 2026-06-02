#!/usr/bin/env bash
# Consistent online backup of the web3keys SQLite database.
# Uses sqlite3 '.backup' (WAL-safe) -> gzip -> rotate. Run as root (reads the
# web3keys-owned db, writes root-only backups). Scheduled via web3keys-backup.timer.
set -euo pipefail

DB="${DB_FILE:-/var/lib/web3keys/web3keys.db}"
DEST="${BACKUP_DIR:-/var/backups/web3keys}"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-14}"

mkdir -p "$DEST"
chmod 700 "$DEST"

if [ ! -f "$DB" ]; then
  echo "backup: database $DB not found, nothing to do" >&2
  exit 0
fi

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/web3keys-$TS.db"

# Atomic, consistent snapshot even while the app is writing (WAL-safe).
sqlite3 "$DB" ".backup '$OUT'"

# Integrity check before keeping it.
if [ "$(sqlite3 "$OUT" 'PRAGMA integrity_check;')" != "ok" ]; then
  echo "backup: integrity check FAILED for $OUT" >&2
  rm -f "$OUT"
  exit 1
fi

gzip -f "$OUT"
chmod 600 "$OUT.gz"

# Prune backups older than the retention window.
find "$DEST" -maxdepth 1 -name 'web3keys-*.db.gz' -mtime "+$RETAIN_DAYS" -delete

echo "backup: wrote $OUT.gz (retain ${RETAIN_DAYS}d); $(ls -1 "$DEST"/web3keys-*.db.gz 2>/dev/null | wc -l) copies on disk"
