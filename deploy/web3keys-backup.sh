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

# Prune local backups older than the retention window.
find "$DEST" -maxdepth 1 -name 'web3keys-*.db.gz' -mtime "+$RETAIN_DAYS" -delete

echo "backup: wrote $OUT.gz (retain ${RETAIN_DAYS}d); $(ls -1 "$DEST"/web3keys-*.db.gz 2>/dev/null | wc -l) local copies"

# Off-site sync to DigitalOcean Spaces (S3-compatible), if configured. The backups
# hold encrypted seeds, so they are uploaded with a PRIVATE ACL. rclone is configured
# purely via env vars (RCLONE_CONFIG_SPACES_*) so secrets never appear in argv.
if [ -n "${DO_SPACES_KEY:-}" ] && [ -n "${DO_SPACES_BUCKET:-}" ]; then
  if ! command -v rclone >/dev/null; then
    echo "offsite: DO_SPACES_* set but rclone is not installed" >&2
    exit 1
  fi
  folder="${DO_SPACES_FOLDER:-/web3keys}"; folder="${folder#/}" # strip any leading slash
  export RCLONE_CONFIG_SPACES_TYPE=s3
  export RCLONE_CONFIG_SPACES_PROVIDER=DigitalOcean
  export RCLONE_CONFIG_SPACES_ACCESS_KEY_ID="$DO_SPACES_KEY"
  export RCLONE_CONFIG_SPACES_SECRET_ACCESS_KEY="$DO_SPACES_SECRET"
  export RCLONE_CONFIG_SPACES_ENDPOINT="$DO_SPACES_ENDPOINT"
  export RCLONE_CONFIG_SPACES_ACL=private
  REMOTE="spaces:${DO_SPACES_BUCKET}/${folder}"

  rclone copy "$OUT.gz" "$REMOTE/" --s3-no-check-bucket --no-traverse
  echo "offsite: uploaded $(basename "$OUT.gz") -> $REMOTE/"

  # Remote retention (best-effort; never fails the run since the upload already succeeded).
  rclone delete "$REMOTE" --min-age "${RETAIN_DAYS}d" --include 'web3keys-*.db.gz' 2>/dev/null || true
else
  echo "offsite: DO_SPACES_* not configured, skipping remote upload"
fi
