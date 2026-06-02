# web3keys backups — recovery reference

Operational reference for the database backups. Everything here is **non-secret**.
The one secret — the age **private identity** — is NOT in this repo and must be kept
off-box (see below).

## What gets backed up, and how

- **Source**: `/var/lib/web3keys/web3keys.db` (users + OTPs; mnemonics are stored
  password-encrypted, never in plaintext).
- **Pipeline** (`deploy/web3keys-backup.sh`): WAL-safe `sqlite3 .backup` snapshot →
  `PRAGMA integrity_check` → gzip → **age client-side encryption** → upload to
  DigitalOcean Spaces (private ACL).
- **Schedule**: `web3keys-backup.timer`, daily at **03:32 UTC** (`Persistent=true`, so a
  missed run catches up on boot).
- **Retention**: 14 days, both local (`/var/backups/web3keys/`) and remote.
- **Locations**:
  - Local: `/var/backups/web3keys/web3keys-<TS>.db.gz.age` (root-only, `chmod 600`)
  - Off-site: `spaces:codenlighten/web3keys/web3keys-<TS>.db.gz.age` (Spaces, private ACL)
  - `<TS>` is a UTC timestamp like `20260602T023736Z`.

## Encryption keys

Asymmetric (age). The **server only has the public recipient** and cannot decrypt its
own backups. The matching **private identity lives off-box** and is required to restore.

- **Recipient (public — safe to share/store anywhere):**

  ```
  age15sqn848haupxwsfakpyj8feqg3eu938d5ujn3lrkfykr9xzykgwse7vuax
  ```

  On the server this is set as `BACKUP_AGE_RECIPIENT` in `/etc/web3keys/web3keys.env`.

- **Private identity (SECRET — not in this repo, not on the server):**
  stored on the operator's local machine at `~/.config/web3keys/backup-identity.txt`
  (`chmod 600`). **Back this up somewhere durable (password manager / hardware token /
  second machine). If it is lost, the encrypted backups are unrecoverable.**

To regenerate the pair on a trusted machine (only when bootstrapping a new key):

```bash
age-keygen -o backup-identity.txt     # the private identity — keep OFF the server
age-keygen -y backup-identity.txt     # prints the recipient -> BACKUP_AGE_RECIPIENT
```

## Restore

You need the off-box `backup-identity.txt`. `age` and `gunzip` must be installed locally.

### 1. Get an encrypted blob

From the server:

```bash
scp root@167.172.154.247:'/var/backups/web3keys/web3keys-<TS>.db.gz.age' .
```

…or from Spaces (with `DO_SPACES_*` exported, via rclone or the DO console):

```bash
rclone copy spaces:codenlighten/web3keys/web3keys-<TS>.db.gz.age .
```

### 2. Decrypt + decompress (off-box, with the private identity)

```bash
age -d -i backup-identity.txt web3keys-<TS>.db.gz.age | gunzip > web3keys.db
```

Without the identity the blob is opaque — `age -d` refuses it.

### 3. Verify, then install on the server

```bash
sqlite3 web3keys.db 'PRAGMA integrity_check;'   # expect: ok
sqlite3 web3keys.db '.tables'                    # expect: users  otps

scp web3keys.db root@167.172.154.247:/tmp/restore.db
ssh root@167.172.154.247 '
  systemctl stop web3keys
  install -o web3keys -g web3keys -m 600 /tmp/restore.db /var/lib/web3keys/web3keys.db
  rm -f /var/lib/web3keys/web3keys.db-wal /var/lib/web3keys/web3keys.db-shm /tmp/restore.db
  systemctl start web3keys
'
```

## Run a backup manually

```bash
ssh root@167.172.154.247 'systemctl start web3keys-backup.service && journalctl -u web3keys-backup.service -n 8 -o cat'
```

## List backups

```bash
# local
ssh root@167.172.154.247 'ls -l /var/backups/web3keys/'
# Spaces (with DO_SPACES_* configured in the env / rclone remote)
rclone lsl spaces:codenlighten/web3keys/ --include 'web3keys-*.db.gz*'
```
