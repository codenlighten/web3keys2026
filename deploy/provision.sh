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
apt-get install -y curl ca-certificates gnupg git nginx sqlite3 ufw rclone age docker.io
systemctl enable --now docker

echo "==> Ensuring swap (small droplets OOM during npm install)"
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q "/swapfile" /etc/fstab || echo "/swapfile none swap sw 0 0" >>/etc/fstab
fi

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

echo "==> Installing production dependencies (frontend is prebuilt & shipped, not built here)"
cd "$APP_DIR"
npm ci --omit=dev || npm install --omit=dev
chown -R web3keys:web3keys "$APP_DIR"

echo "==> Installing systemd units (api + worker)"
cp "$APP_DIR/deploy/web3keys.service" /etc/systemd/system/web3keys.service
cp "$APP_DIR/deploy/web3keys-worker.service" /etc/systemd/system/web3keys-worker.service
systemctl daemon-reload
systemctl enable web3keys web3keys-worker

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
  1. Bring up Postgres + Redis (Docker):
       docker run -d --name web3keys-postgres --restart unless-stopped \
         -e POSTGRES_USER=web3keys -e POSTGRES_DB=web3keys -e POSTGRES_PASSWORD=<pw> \
         -p 127.0.0.1:5432:5432 -v web3keys-pgdata:/var/lib/postgresql/data postgres:16-alpine
       docker run -d --name web3keys-redis --restart unless-stopped \
         -p 127.0.0.1:6379:6379 -v web3keys-redisdata:/data redis:7-alpine redis-server --appendonly yes
  2. Create /etc/web3keys/web3keys.env (see .env.example): JWT_SECRET, SECRETS_KEY,
     DATABASE_URL, REDIS_URL, SMTP_*, DO_SPACES_*, BACKUP_AGE_RECIPIENT, WALLET_DOMAIN, BASE_URL.
       chown root:web3keys /etc/web3keys/web3keys.env && chmod 640 /etc/web3keys/web3keys.env
  3. Ship the prebuilt frontend from a dev machine:  bash deploy/build-and-ship.sh root@<host>
  4. Start services:  systemctl start web3keys web3keys-worker
  5. DNS A records for web3keys.com + www -> this droplet, then TLS:
       certbot --nginx -d web3keys.com -d www.web3keys.com --redirect -m you@web3keys.com --agree-tos
NOTE
