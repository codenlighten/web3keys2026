-- Non-custodial pivot: the server no longer holds ANY key material. Drop the seed-share
-- stores entirely. Add an opaque encrypted-backup blob (server cannot decrypt) and
-- WebAuthn credential storage. Keys are generated and used client-side; the server only
-- stores public xpubs/identity (already on users) and broadcasts signed transactions.

DROP TABLE IF EXISTS user_shares;
DROP TABLE IF EXISTS ttp_shares;

CREATE TABLE IF NOT EXISTS backups (
  user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  scheme     TEXT NOT NULL,            -- e.g. 'passkey-prf-aesgcm' | 'passphrase-scrypt-aesgcm'
  ciphertext TEXT NOT NULL,            -- opaque; only the user can decrypt (client-side)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT UNIQUE NOT NULL,  -- base64url
  public_key    TEXT NOT NULL,         -- base64url COSE key
  counter       BIGINT NOT NULL DEFAULT 0,
  transports    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(user_id);
