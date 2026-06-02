#!/usr/bin/env bash
# One-time droplet provisioning for web3keys (Ubuntu 24.04). Run as root.
#   curl -fsSL .../provision.sh | bash   — or scp + bash deploy/provision.sh
set -euo pipefail

NODE_MAJOR=22
APP_DIR=/opt/web3keys
DATA_DIR=/var/lib/web3keys
ENV_DIR=/etc/web3keys
REPO=https://github.com/codenlighten/web3keys2026.git

echo "==> Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg git nginx sqlite3 ufw rclone age

echo "==> Installing Node ${NODE_MAJOR}.x (NodeSource)"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2 | tr -d v)" != "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
node -v && npm -v

echo "==> Installing certbot (snap)"
if ! command -v certbot >/dev/null; then
  apt-get install -y snapd
  snap install core && snap refresh core
  snap install --classic certbot
  ln -sf /snap/bin/certbot /usr/bin/certbot
fi

echo "==> Creating service user and directories"
id -u web3keys >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin web3keys
mkdir -p "$APP_DIR" "$DATA_DIR" "$ENV_DIR"
chown -R web3keys:web3keys "$DATA_DIR"
chmod 750 "$ENV_DIR"

echo "==> Cloning / updating repo into ${APP_DIR}"
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO" "$APP_DIR"
fi

echo "==> Installing dependencies (incl dev — needed to build the frontend)"
cd "$APP_DIR"
npm ci || npm install

echo "==> Building the web frontend (packages/web/dist)"
npm run build -w @web3keys/web
chown -R web3keys:web3keys "$APP_DIR"

echo "==> Installing systemd unit"
cp "$APP_DIR/deploy/web3keys.service" /etc/systemd/system/web3keys.service
systemctl daemon-reload
systemctl enable web3keys

echo "==> Installing nginx site"
cp "$APP_DIR/deploy/nginx-web3keys.conf" /etc/nginx/sites-available/web3keys
ln -sf /etc/nginx/sites-available/web3keys /etc/nginx/sites-enabled/web3keys
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "==> Installing database backup (daily systemd timer)"
install -m 0755 "$APP_DIR/deploy/web3keys-backup.sh" /usr/local/bin/web3keys-backup.sh
cp "$APP_DIR/deploy/web3keys-backup.service" /etc/systemd/system/web3keys-backup.service
cp "$APP_DIR/deploy/web3keys-backup.timer" /etc/systemd/system/web3keys-backup.timer
systemctl daemon-reload
systemctl enable --now web3keys-backup.timer

echo "==> Configuring firewall (ufw): allow SSH + HTTP/HTTPS"
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

cat <<'NOTE'

==> Provisioning complete.

Next steps (manual, require secrets / DNS):
  1. Create the env file:  /etc/web3keys/web3keys.env   (see .env.example; set JWT_SECRET + SMTP_*)
       chown root:web3keys /etc/web3keys/web3keys.env && chmod 640 /etc/web3keys/web3keys.env
  2. Start the service:    systemctl start web3keys && systemctl status web3keys
  3. Point DNS A records for web3keys.com + www to THIS droplet, then issue TLS:
       certbot --nginx -d web3keys.com -d www.web3keys.com --redirect -m you@web3keys.com --agree-tos
NOTE
