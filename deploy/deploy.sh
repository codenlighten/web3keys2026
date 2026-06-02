#!/usr/bin/env bash
# Redeploy on the (RAM-constrained) droplet. The React frontend is built OFF-box and
# shipped as packages/web/dist (see deploy/build-and-ship.sh) — we do NOT run vite here,
# it OOMs on small droplets. This installs production deps only and restarts the services.
# Run as root.
set -euo pipefail
APP_DIR=/opt/web3keys

git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true

echo "==> Pulling latest"
git -C "$APP_DIR" pull --ff-only

echo "==> Installing production dependencies (no dev — frontend is prebuilt & shipped)"
cd "$APP_DIR"
npm ci --omit=dev || npm install --omit=dev

if [ ! -f packages/web/dist/index.html ]; then
  echo "WARNING: packages/web/dist missing — build & ship it from a dev machine:"
  echo "         bash deploy/build-and-ship.sh root@<host>"
fi
chown -R web3keys:web3keys "$APP_DIR"

echo "==> Installing systemd units"
cp deploy/web3keys.service /etc/systemd/system/web3keys.service
cp deploy/web3keys-worker.service /etc/systemd/system/web3keys-worker.service
systemctl daemon-reload
systemctl enable web3keys web3keys-worker >/dev/null 2>&1 || true

echo "==> Restarting services"
systemctl restart web3keys web3keys-worker
sleep 2
systemctl --no-pager is-active web3keys web3keys-worker
echo "==> Readiness:"
curl -fsS http://127.0.0.1:3000/readyz && echo
