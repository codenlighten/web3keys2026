#!/usr/bin/env bash
# Redeploy latest code on an already-provisioned droplet. Run as root.
set -euo pipefail
APP_DIR=/opt/web3keys

echo "==> Pulling latest"
git -C "$APP_DIR" pull --ff-only

echo "==> Installing production dependencies"
cd "$APP_DIR"
npm ci --omit=dev || npm install --omit=dev
chown -R web3keys:web3keys "$APP_DIR"

echo "==> Restarting service"
cp "$APP_DIR/deploy/web3keys.service" /etc/systemd/system/web3keys.service
systemctl daemon-reload
systemctl restart web3keys
sleep 1
systemctl --no-pager --full status web3keys | head -n 12
echo "==> Health:"
curl -fsS http://127.0.0.1:3000/health && echo
