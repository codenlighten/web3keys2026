-- Phase 2: threshold custody. Replace single-blob AES seed custody with two service-held
-- Shamir shares in SEPARATE stores: S2 sealed under the user's password (user_shares),
-- S3 sealed under the server master key (ttp_shares, later migrates to a third party).

CREATE TABLE IF NOT EXISTS user_shares (
  user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enc_salt   TEXT NOT NULL,
  iv         TEXT NOT NULL,
  tag        TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ttp_shares (
  user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  iv          TEXT NOT NULL,
  tag         TEXT NOT NULL,
  ciphertext  TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Drop the legacy single-blob seed custody columns (clean cutover; test data only).
ALTER TABLE users DROP COLUMN IF EXISTS enc_salt;
ALTER TABLE users DROP COLUMN IF EXISTS enc_iv;
ALTER TABLE users DROP COLUMN IF EXISTS enc_tag;
ALTER TABLE users DROP COLUMN IF EXISTS enc_ciphertext;
