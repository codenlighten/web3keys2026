-- web3keys initial schema (Postgres).
-- Note: the enc_* seed-custody columns are carried over from the SQLite version for
-- Phase 1 parity; Phase 2 (threshold custody) replaces them with a server_share column.

CREATE TABLE IF NOT EXISTS users (
  id                BIGSERIAL PRIMARY KEY,
  email             TEXT UNIQUE NOT NULL,
  alias             TEXT UNIQUE NOT NULL,
  password_verifier TEXT NOT NULL,
  enc_salt          TEXT,
  enc_iv            TEXT,
  enc_tag           TEXT,
  enc_ciphertext    TEXT,
  identity_pubkey   TEXT NOT NULL,
  finance_xpub      TEXT NOT NULL,
  tokens_xpub       TEXT NOT NULL,
  identity_xpub     TEXT NOT NULL,
  receive_index     INTEGER NOT NULL DEFAULT 0,
  verified          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS otps (
  email      TEXT NOT NULL,
  purpose    TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (email, purpose)
);

CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at BIGINT NOT NULL,
  revoked    BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_sessions_email ON sessions(email);

CREATE TABLE IF NOT EXISTS audit_log (
  id     BIGSERIAL PRIMARY KEY,
  ts     TIMESTAMPTZ NOT NULL DEFAULT now(),
  email  TEXT,
  action TEXT NOT NULL,
  ip     TEXT,
  detail JSONB
);
CREATE INDEX IF NOT EXISTS idx_audit_email_ts ON audit_log(email, ts);

CREATE TABLE IF NOT EXISTS transactions (
  id          BIGSERIAL PRIMARY KEY,
  txid        TEXT NOT NULL,
  user_id     BIGINT REFERENCES users(id),
  direction   TEXT NOT NULL,            -- 'in' | 'out'
  amount_sats BIGINT NOT NULL,
  address     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, created_at);

CREATE TABLE IF NOT EXISTS addresses (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  address    TEXT UNIQUE NOT NULL,
  change     INTEGER NOT NULL DEFAULT 0,
  idx        INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  type       TEXT NOT NULL,
  payload    JSONB,
  read       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kyc (
  user_id    BIGINT PRIMARY KEY REFERENCES users(id),
  level      TEXT NOT NULL DEFAULT 'none',
  status     TEXT NOT NULL DEFAULT 'unverified',
  data       JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhooks (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  url        TEXT NOT NULL,
  secret     TEXT,
  events     JSONB NOT NULL DEFAULT '[]'::jsonb,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
