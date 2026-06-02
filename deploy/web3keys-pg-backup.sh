#!/usr/bin/env bash
# Postgres backup: pg_dump -> gzip -> (optional) age-encrypt -> (optional) DO Spaces.
# Reuses the same BACKUP_AGE_RECIPIENT + DO_SPACES_* as the sqlite backup. Run as root.
#
# Postgres runs in Docker on the droplet, so by default we dump via the container. Set
# PG_CONTAINER to its name (default web3keys-postgres). Override with PG_DUMP_CMD to use a
# host pg_dump against DATABASE_URL instead.
set -euo pipefail

DEST="${PG_BACKUP_DIR:-/var/backups/web3keys-pg}"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-14}"
PG_CONTAINER="${PG_CONTAINER:-web3keys-postgres}"

mkdir -p "$DEST"
chmod 700 "$DEST"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/web3keys-pg-$TS.sql.gz"

if [ -n "${PG_DUMP_CMD:-}" ]; then
  $PG_DUMP_CMD | gzip >"$OUT"
else
  docker exec "$PG_CONTAINER" pg_dump -U web3keys web3keys | gzip >"$OUT"
fi

# Integrity sanity: a valid gzip with content.
gzip -t "$OUT"
[ "$(stat -c%s "$OUT")" -gt 100 ] || {
  echo "pg backup: dump too small" >&2
  rm -f "$OUT"
  exit 1
}

# Client-side encryption (same model as the sqlite backups): the server can't decrypt.
if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  command -v age >/dev/null || {
    echo "age not installed" >&2
    exit 1
  }
  age -r "$BACKUP_AGE_RECIPIENT" -o "$OUT.age" "$OUT"
  rm -f "$OUT"
  OUT="$OUT.age"
fi
chmod 600 "$OUT"

# Local retention.
find "$DEST" -maxdepth 1 -name 'web3keys-pg-*' -mtime "+$RETAIN_DAYS" -delete

# Off-site to DigitalOcean Spaces (private ACL), if configured.
if [ -n "${DO_SPACES_KEY:-}" ] && [ -n "${DO_SPACES_BUCKET:-}" ]; then
  folder="${DO_SPACES_FOLDER:-/web3keys}"
  folder="${folder#/}"
  export RCLONE_CONFIG_SPACES_TYPE=s3 RCLONE_CONFIG_SPACES_PROVIDER=DigitalOcean
  export RCLONE_CONFIG_SPACES_ACCESS_KEY_ID="$DO_SPACES_KEY"
  export RCLONE_CONFIG_SPACES_SECRET_ACCESS_KEY="$DO_SPACES_SECRET"
  export RCLONE_CONFIG_SPACES_ENDPOINT="$DO_SPACES_ENDPOINT"
  export RCLONE_CONFIG_SPACES_ACL=private
  rclone copy "$OUT" "spaces:${DO_SPACES_BUCKET}/${folder}/pg/" --s3-no-check-bucket --no-traverse
  rclone delete "spaces:${DO_SPACES_BUCKET}/${folder}/pg" --min-age "${RETAIN_DAYS}d" \
    --include 'web3keys-pg-*' 2>/dev/null || true
fi

echo "pg backup: $OUT"
