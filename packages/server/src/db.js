'use strict';

const { query, one } = require('./db/pool');
const { migrate } = require('./db/migrate');

/**
 * Application data access (Postgres). All methods are async.
 *
 * What is stored per user (and, deliberately, what is NOT):
 *   STORED: email, password verifier, PUBLIC xpubs + identity public key, paymail alias,
 *           receive-address counter; plus two SEALED Shamir shares in separate stores —
 *           S2 in user_shares (sealed under the user's password) and S3 in ttp_shares
 *           (sealed under the server master key, never in the DB).
 *   NOT STORED: the plaintext mnemonic, any private key, or any single reconstructable
 *           key. At rest, no two openable shares exist without a password / master key.
 */

async function init() {
  return migrate();
}

// ── users ────────────────────────────────────────────────────────────────────

async function createUser(u) {
  return one(
    `INSERT INTO users
       (email, alias, password_verifier,
        identity_pubkey, finance_xpub, tokens_xpub, identity_xpub, verified)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      u.email,
      u.alias,
      u.passwordVerifier,
      u.identityPubkey,
      u.financeXpub,
      u.tokensXpub,
      u.identityXpub,
      !!u.verified,
    ]
  );
}

// ── threshold shares (S2 in user_shares, S3 in ttp_shares — separate stores) ──────

async function putUserShare(userId, s) {
  return query(
    `INSERT INTO user_shares (user_id, enc_salt, iv, tag, ciphertext)
       VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id) DO UPDATE
       SET enc_salt = EXCLUDED.enc_salt, iv = EXCLUDED.iv, tag = EXCLUDED.tag,
           ciphertext = EXCLUDED.ciphertext`,
    [userId, s.encSalt, s.iv, s.tag, s.ciphertext]
  );
}

async function getUserShare(userId) {
  const r = await one('SELECT * FROM user_shares WHERE user_id = $1', [userId]);
  return r ? { encSalt: r.enc_salt, iv: r.iv, tag: r.tag, ciphertext: r.ciphertext } : null;
}

async function putTtpShare(userId, s) {
  return query(
    `INSERT INTO ttp_shares (user_id, iv, tag, ciphertext, key_version)
       VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id) DO UPDATE
       SET iv = EXCLUDED.iv, tag = EXCLUDED.tag, ciphertext = EXCLUDED.ciphertext,
           key_version = EXCLUDED.key_version`,
    [userId, s.iv, s.tag, s.ciphertext, s.keyVersion || 1]
  );
}

async function getTtpShare(userId) {
  const r = await one('SELECT * FROM ttp_shares WHERE user_id = $1', [userId]);
  return r ? { iv: r.iv, tag: r.tag, ciphertext: r.ciphertext, keyVersion: r.key_version } : null;
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

async function setPassword(email, passwordVerifier) {
  const { rowCount } = await query('UPDATE users SET password_verifier = $2 WHERE email = $1', [
    email,
    passwordVerifier,
  ]);
  return rowCount > 0;
}

async function setTotp(email, totpEnc, enabled) {
  const { rowCount } = await query(
    'UPDATE users SET totp_enc = $2, totp_enabled = $3 WHERE email = $1',
    [email, totpEnc, !!enabled]
  );
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

// ── transactions (history) ─────────────────────────────────────────────────────

async function insertTransaction(t) {
  return one(
    `INSERT INTO transactions (txid, user_id, direction, amount_sats, address, status, vout)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      t.txid,
      t.userId || null,
      t.direction,
      t.amountSats,
      t.address || null,
      t.status || 'pending',
      t.vout ?? null,
    ]
  );
}

async function listTransactions(userId, { limit = 50 } = {}) {
  const { rows } = await query(
    'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
    [userId, limit]
  );
  return rows.map((r) => ({
    txid: r.txid,
    direction: r.direction,
    amountSats: Number(r.amount_sats),
    address: r.address,
    vout: r.vout,
    status: r.status,
    createdAt: r.created_at,
  }));
}

/** Set of "txid:vout" already recorded as incoming for a user (deposit dedup). */
async function incomingOutpoints(userId) {
  const { rows } = await query(
    "SELECT txid, vout FROM transactions WHERE user_id = $1 AND direction = 'in'",
    [userId]
  );
  return new Set(rows.map((r) => `${r.txid}:${r.vout}`));
}

async function listUsers() {
  const { rows } = await query('SELECT id, email, finance_xpub FROM users WHERE verified = TRUE');
  return rows;
}

// ── notifications ────────────────────────────────────────────────────────────

async function insertNotification(n) {
  return one('INSERT INTO notifications (user_id, type, payload) VALUES ($1,$2,$3) RETURNING *', [
    n.userId,
    n.type,
    n.payload ? JSON.stringify(n.payload) : null,
  ]);
}

async function listNotifications(userId, { unreadOnly = false, limit = 100 } = {}) {
  const { rows } = await query(
    `SELECT * FROM notifications WHERE user_id = $1 ${unreadOnly ? 'AND read = FALSE' : ''}
       ORDER BY created_at DESC, id DESC LIMIT $2`,
    [userId, limit]
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
    read: r.read,
    createdAt: r.created_at,
  }));
}

async function markNotificationRead(userId, id) {
  const { rowCount } = await query(
    'UPDATE notifications SET read = TRUE WHERE user_id = $1 AND id = $2',
    [userId, id]
  );
  return rowCount > 0;
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
  setPassword,
  setTotp,
  bumpReceiveIndex,
  putUserShare,
  getUserShare,
  putTtpShare,
  getTtpShare,
  insertTransaction,
  listTransactions,
  incomingOutpoints,
  listUsers,
  insertNotification,
  listNotifications,
  markNotificationRead,
  upsertOtp,
  getOtp,
  incrementOtpAttempts,
  deleteOtp,
  audit,
};
