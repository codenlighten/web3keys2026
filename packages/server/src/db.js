'use strict';

const { query, one } = require('./db/pool');
const { migrate } = require('./db/migrate');

/**
 * Application data access (Postgres). All methods are async.
 *
 * NON-CUSTODIAL: the server stores only PUBLIC material and opaque ciphertext.
 *   STORED: email, password verifier, PUBLIC xpubs + identity public key, paymail alias,
 *           receive-address counter, an opaque user-encrypted backup blob (server cannot
 *           decrypt), and WebAuthn credentials.
 *   NOT STORED: any seed, private key, or share. The server can never sign.
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

// ── opaque encrypted backup (Tier 1) — server CANNOT decrypt ──────────────────────

async function putBackup(userId, { scheme, ciphertext }) {
  return query(
    `INSERT INTO backups (user_id, scheme, ciphertext, updated_at)
       VALUES ($1,$2,$3, now())
     ON CONFLICT (user_id) DO UPDATE
       SET scheme = EXCLUDED.scheme, ciphertext = EXCLUDED.ciphertext, updated_at = now()`,
    [userId, scheme, ciphertext]
  );
}

async function getBackup(userId) {
  const r = await one('SELECT scheme, ciphertext FROM backups WHERE user_id = $1', [userId]);
  return r || null;
}

// ── WebAuthn credentials (passkeys) ──────────────────────────────────────────────

async function addCredential(c) {
  return one(
    `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [c.userId, c.credentialId, c.publicKey, c.counter || 0, c.transports || null]
  );
}

async function getCredentials(userId) {
  const { rows } = await query('SELECT * FROM webauthn_credentials WHERE user_id = $1', [userId]);
  return rows;
}

async function getCredentialById(credentialId) {
  return one('SELECT * FROM webauthn_credentials WHERE credential_id = $1', [credentialId]);
}

async function updateCredentialCounter(credentialId, counter) {
  return query('UPDATE webauthn_credentials SET counter = $2 WHERE credential_id = $1', [
    credentialId,
    counter,
  ]);
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

// ── account (GDPR export / delete) ──────────────────────────────────────────────

async function listAuditForEmail(email, { limit = 500 } = {}) {
  const { rows } = await query(
    'SELECT ts, action, ip, detail FROM audit_log WHERE email = $1 ORDER BY ts DESC LIMIT $2',
    [email, limit]
  );
  return rows;
}

async function deleteAuditForEmail(email) {
  return query('DELETE FROM audit_log WHERE email = $1', [email]);
}

/** Permanently delete a user and all dependent rows (children first, then the user). */
async function deleteUser(userId) {
  for (const t of [
    'notifications',
    'transactions',
    'backups',
    'webauthn_credentials',
    'kyc',
    'addresses',
    'webhooks',
  ]) {
    await query(`DELETE FROM ${t} WHERE user_id = $1`, [userId]).catch(() => {});
  }
  const { rowCount } = await query('DELETE FROM users WHERE id = $1', [userId]);
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
  putBackup,
  getBackup,
  addCredential,
  getCredentials,
  getCredentialById,
  updateCredentialCounter,
  insertTransaction,
  listTransactions,
  incomingOutpoints,
  listUsers,
  insertNotification,
  listNotifications,
  markNotificationRead,
  listAuditForEmail,
  deleteAuditForEmail,
  deleteUser,
  upsertOtp,
  getOtp,
  incrementOtpAttempts,
  deleteOtp,
  audit,
};
