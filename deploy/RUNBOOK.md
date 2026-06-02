# web3keys ops runbook

Operational procedures. Pairs with `deploy/BACKUP.md` (backup encryption keys + restore).

## Architecture (production)

- Node API (`packages/server`) on `127.0.0.1:3000` behind nginx + Let's Encrypt TLS.
- Static React app served from `packages/web/dist` (`WEB_DIR`).
- Worker (`packages/worker`) — deposit sync + (future) queues.
- Postgres + Redis (Docker, `infra/docker-compose.yml`, bound to localhost).
- **Non-custodial:** the server holds NO wallet keys. Keys are generated and used in the
  browser; the server stores only public xpubs + opaque encrypted backups and broadcasts
  client-signed transactions.

## Secrets (`/etc/web3keys/web3keys.env`, chmod 640 root:web3keys)

`JWT_SECRET`, `SECRETS_KEY` (seals TOTP secrets only — not custody), `DATABASE_URL`,
`REDIS_URL`, `SMTP_*`, `DO_SPACES_*`, `BACKUP_AGE_RECIPIENT`, `WALLET_DOMAIN`, `BASE_URL`.
Generate secrets with `openssl rand -hex 32`. Never commit; keep only on the droplet.

## Deploy / rollback

```bash
# deploy latest of the current branch
ssh root@<host> 'bash /opt/web3keys/deploy/deploy.sh'   # pull → npm ci → build web → migrate → restart
# rollback: check out the previous commit and redeploy
ssh root@<host> 'git -C /opt/web3keys checkout <prev-sha> && bash /opt/web3keys/deploy/deploy.sh'
```

Migrations are forward-only (`packages/server/migrations/*.sql`), applied on startup. Roll
back code with a compensating migration if a schema change must be reversed.

## Backups

- **App DB (Postgres):** `deploy/web3keys-pg-backup.sh` → `pg_dump` → gzip → age-encrypt →
  Spaces (`/web3keys/pg/`), 14-day retention. Schedule via a daily systemd timer.
- Restore: `age -d -i identity.txt web3keys-pg-<TS>.sql.gz.age | gunzip | psql "$DATABASE_URL"`.
- The age identity is **off-box** (see `BACKUP.md`); without it, encrypted backups can't be read.

## Key rotation

- **JWT_SECRET** — rotating invalidates all sessions (users re-login). Safe anytime.
- **SECRETS_KEY** — re-encrypts TOTP secrets; rotating without re-sealing breaks 2FA. Plan a
  re-seal migration (decrypt with old, encrypt with new) before changing.
- **age backup identity** — generate a new keypair, set the new `BACKUP_AGE_RECIPIENT`; old
  backups still need the old identity to restore (keep it archived).
- **User keys** — non-custodial; the server cannot and does not rotate user wallet keys.

## Incident basics

- Logs: `journalctl -u web3keys -f` (pino JSON; request ids via `x-request-id`).
- Health: `/healthz` (liveness), `/readyz` (Postgres + Redis reachability).
- Suspected breach: rotate `JWT_SECRET` (forces re-login). User funds are NOT at risk from a
  server breach — the server holds no keys; only opaque (user-encrypted) backups.
- Lockout/abuse: `lockout:*` + rate-limit keys live in Redis.

## TLS / DNS

`certbot --nginx -d web3keys.com -d www.web3keys.com --redirect` (auto-renews). Requires the
A records to point at the droplet.

## Compliance notes

- GDPR: `GET /api/account/export` (data portability) and `DELETE /api/account` (erasure;
  re-auth required, wipes user rows + audit by email).
- ToS / Privacy copy: requires legal review (placeholder pending). Custodial-style KYC/AML is
  out of scope by design — the service is non-custodial — but confirm per jurisdiction.
