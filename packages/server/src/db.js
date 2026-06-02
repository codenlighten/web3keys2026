'use strict';

const { query, one } = require('./db/pool');
const { migrate } = require('./db/migrate');

/**
 * Application data access (Postgres). All methods are async.
 *
 * What is stored per user (and, deliberately, what is NOT):
 *   STORED: email, password verifier, AES-GCM-sealed mnemonic (Phase 1; replaced by a
 *           threshold server-share in Phase 2), PUBLIC xpubs + identity public key,
 *           paymail alias, receive-address counter.
 *   NOT STORED: the plaintext mnemonic or any private key.
 */

async function init() {
  return migrate();
}

// ── users ────────────────────────────────────────────────────────────────────

async function createUser(u) {
  return one(
    `INSERT INTO users
       (email, alias, password_verifier, enc_salt, enc_iv, enc_tag, enc_ciphertext,
        identity_pubkey, finance_xpub, tokens_xpub, identity_xpub, verified)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      u.email,
      u.alias,
      u.passwordVerifier,
      u.sealed.encSalt,
      u.sealed.iv,
      u.sealed.tag,
      u.sealed.ciphertext,
      u.identityPubkey,
      u.financeXpub,
      u.tokensXpub,
      u.identityXpub,
      !!u.verified,
    ]
  );
}

async function findByEmail(email) {
  return one('SELECT * FROM users WHERE email = $1', [email]);
}

async function findByAlias(alias) {
  return one('SELECT * FROM users WHERE alias = $1', [alias]);
}

async function setVerified(email) {
  const { rowCount } = await query('UPDATE users SET verified = TRUE WHERE email = $1', [email]);
  return rowCount > 0;
}

async function bumpReceiveIndex(email) {
  const row = await one(
    'UPDATE users SET receive_index = receive_index + 1 WHERE email = $1 RETURNING receive_index',
    [email]
  );
  return row ? row.receive_index : null;
}

// ── OTPs ─────────────────────────────────────────────────────────────────────

async function upsertOtp({ email, purpose, codeHash, expiresAt }) {
  return query(
    `INSERT INTO otps (email, purpose, code_hash, expires_at, attempts)
       VALUES ($1,$2,$3,$4,0)
     ON CONFLICT (email, purpose)
       DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0`,
    [email, purpose, codeHash, expiresAt]
  );
}

async function getOtp(email, purpose) {
  const row = await one('SELECT * FROM otps WHERE email = $1 AND purpose = $2', [email, purpose]);
  if (row) row.expires_at = Number(row.expires_at); // bigint → number
  return row;
}

async function incrementOtpAttempts(email, purpose) {
  return query('UPDATE otps SET attempts = attempts + 1 WHERE email = $1 AND purpose = $2', [
    email,
    purpose,
  ]);
}

async function deleteOtp(email, purpose) {
  return query('DELETE FROM otps WHERE email = $1 AND purpose = $2', [email, purpose]);
}

// ── audit log ─────────────────────────────────────────────────────────────────

async function audit({ email, action, ip, detail }) {
  return query('INSERT INTO audit_log (email, action, ip, detail) VALUES ($1,$2,$3,$4)', [
    email || null,
    action,
    ip || null,
    detail ? JSON.stringify(detail) : null,
  ]);
}

module.exports = {
  init,
  createUser,
  findByEmail,
  findByAlias,
  setVerified,
  bumpReceiveIndex,
  upsertOtp,
  getOtp,
  incrementOtpAttempts,
  deleteOtp,
  audit,
};
