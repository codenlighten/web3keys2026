#!/usr/bin/env bash
# Build the frontend locally (the droplet is too small to run vite) and ship dist/ to it.
# Then run deploy.sh on the host to install deps + restart.
#   bash deploy/build-and-ship.sh root@167.172.154.247
set -euo pipefail
HOST="${1:-root@167.172.154.247}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Building frontend locally"
( cd "$ROOT" && npm run build -w @web3keys/web )

echo "==> Shipping dist to $HOST"
if command -v rsync >/dev/null; then
  rsync -az --delete "$ROOT/packages/web/dist/" "$HOST:/opt/web3keys/packages/web/dist/"
else
  ssh "$HOST" 'rm -rf /opt/web3keys/packages/web/dist'
  scp -r "$ROOT/packages/web/dist" "$HOST:/opt/web3keys/packages/web/"
fi

echo "==> Deploying on $HOST"
ssh "$HOST" 'bash /opt/web3keys/deploy/deploy.sh'
