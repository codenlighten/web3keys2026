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
ARTIFACT="$OUT.gz"

# Client-side encryption (defense in depth): if a recipient public key is configured,
# encrypt the blob with age. This is ASYMMETRIC — the server holds only the PUBLIC
# recipient key and cannot decrypt; the matching private identity lives off-box. So a
# compromise of this droplet OR the Spaces credentials still exposes nothing usable.
if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  if ! command -v age >/dev/null; then
    echo "encrypt: BACKUP_AGE_RECIPIENT set but 'age' is not installed" >&2
    rm -f "$ARTIFACT"
    exit 1
  fi
  age -r "$BACKUP_AGE_RECIPIENT" -o "$ARTIFACT.age" "$ARTIFACT"
  rm -f "$ARTIFACT" # remove the unencrypted intermediate; only the .age remains
  ARTIFACT="$ARTIFACT.age"
  echo "encrypt: sealed with age (recipient ${BACKUP_AGE_RECIPIENT:0:20}...)"
else
  echo "encrypt: BACKUP_AGE_RECIPIENT not set — storing UNENCRYPTED gzip"
fi
chmod 600 "$ARTIFACT"

# Prune local backups older than the retention window (covers .gz and .gz.age).
find "$DEST" -maxdepth 1 -name 'web3keys-*.db.gz*' -mtime "+$RETAIN_DAYS" -delete

echo "backup: wrote $ARTIFACT (retain ${RETAIN_DAYS}d); $(ls -1 "$DEST"/web3keys-*.db.gz* 2>/dev/null | wc -l) local copies"

# Off-site sync to DigitalOcean Spaces (S3-compatible), if configured. Uploaded with a
# PRIVATE ACL; rclone is configured purely via env vars so secrets never appear in argv.
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

  rclone copy "$ARTIFACT" "$REMOTE/" --s3-no-check-bucket --no-traverse
  echo "offsite: uploaded $(basename "$ARTIFACT") -> $REMOTE/"

  # Remote retention (best-effort; never fails the run since the upload already succeeded).
  rclone delete "$REMOTE" --min-age "${RETAIN_DAYS}d" --include 'web3keys-*.db.gz*' 2>/dev/null || true
else
  echo "offsite: DO_SPACES_* not configured, skipping remote upload"
fi
