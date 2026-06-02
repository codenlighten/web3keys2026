'use strict';

const crypto = require('crypto');
const security = require('./security');
const { config } = require('./config');

/**
 * Sealing of the two service-held Shamir shares (see wallet-core threshold module).
 *
 *   - S2 (service share)  → sealed under a key derived from the USER'S PASSWORD (scrypt).
 *                           Stored in the main DB. Unusable without the user's password.
 *   - S3 (TTP-bound share) → sealed under the SERVER MASTER KEY (systemd secret, never in
 *                           the DB). Stored in a separate table/store. Later migrates to
 *                           a trusted third party.
 *
 * Property: a database dump of either/both stores cannot reconstruct the seed — S2 needs
 * the user's password, S3 needs the master key (which is not in the database).
 */

function masterKey() {
  if (!config.shareMasterKey) throw new Error('SHARE_MASTER_KEY is not configured');
  // Accept any-length secret; derive a stable 32-byte AES key.
  return crypto.createHash('sha256').update(String(config.shareMasterKey)).digest();
}

// ── S2: password-sealed service share ─────────────────────────────────────────

/** @returns {{ encSalt, iv, tag, ciphertext }} (hex) */
function sealUserShare(shareString, password) {
  const salt = crypto.randomBytes(16);
  const key = security.scrypt(password, salt);
  return { encSalt: salt.toString('hex'), ...security.aesEncrypt(shareString, key) };
}

function openUserShare(sealed, password) {
  const key = security.scrypt(password, Buffer.from(sealed.encSalt, 'hex'));
  return security.aesDecrypt(sealed, key).toString('utf8'); // throws on wrong password
}

// ── master-key sealing (S3, and other server-only secrets like TOTP) ────────────

/** Seal a string under the server master key → JSON string {iv,tag,ciphertext,v}. */
function sealMaster(plaintext) {
  return JSON.stringify({ ...security.aesEncrypt(plaintext, masterKey()), v: 1 });
}

/** Open a sealMaster() JSON string. */
function openMaster(json) {
  return security.aesDecrypt(JSON.parse(json), masterKey()).toString('utf8');
}

// ── S3: master-key-sealed, TTP-bound share ─────────────────────────────────────

/** @returns {{ iv, tag, ciphertext, keyVersion }} (hex) */
function sealTtpShare(shareString) {
  return { ...security.aesEncrypt(shareString, masterKey()), keyVersion: 1 };
}

function openTtpShare(sealed) {
  return security.aesDecrypt(sealed, masterKey()).toString('utf8');
}

module.exports = {
  sealUserShare,
  openUserShare,
  sealTtpShare,
  openTtpShare,
  sealMaster,
  openMaster,
};
