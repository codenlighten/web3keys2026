-- Phase 3: TOTP two-factor auth. The TOTP secret is stored sealed under the server
-- master key (never plaintext), and only enforced once the user has confirmed enrollment.

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enc TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;
