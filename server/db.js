'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('./config');

/**
 * Application database (users, OTP challenges). Built on node:sqlite.
 *
 * What is stored per user (and, deliberately, what is NOT):
 *   STORED: email, password verifier, AES-GCM-sealed mnemonic, PUBLIC xpubs +
 *           identity public key, paymail alias, receive-address counter.
 *   NOT STORED: the plaintext mnemonic or any private key.
 */
let db;

function init() {
  if (db) return db;
  if (config.dbFile !== ':memory:') {
    fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
  }
  db = new DatabaseSync(config.dbFile);
  if (config.dbFile !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      alias TEXT UNIQUE NOT NULL,
      password_verifier TEXT NOT NULL,
      enc_salt TEXT NOT NULL,
      enc_iv TEXT NOT NULL,
      enc_tag TEXT NOT NULL,
      enc_ciphertext TEXT NOT NULL,
      identity_pubkey TEXT NOT NULL,
      finance_xpub TEXT NOT NULL,
      tokens_xpub TEXT NOT NULL,
      identity_xpub TEXT NOT NULL,
      receive_index INTEGER NOT NULL DEFAULT 0,
      verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS otps (
      email TEXT NOT NULL,
      purpose TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (email, purpose)
    );
  `);
  return db;
}

function get() {
  return db || init();
}

// ── users ──────────────────────────────────────────────────────────────────────

function createUser(u) {
  return get()
    .prepare(
      `INSERT INTO users
        (email, alias, password_verifier, enc_salt, enc_iv, enc_tag, enc_ciphertext,
         identity_pubkey, finance_xpub, tokens_xpub, identity_xpub, verified, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
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
      u.verified ? 1 : 0,
      u.createdAt
    );
}

function findByEmail(email) {
  return get().prepare('SELECT * FROM users WHERE email = ?').get(email) || null;
}

function findByAlias(alias) {
  return get().prepare('SELECT * FROM users WHERE alias = ?').get(alias) || null;
}

function setVerified(email) {
  return get().prepare('UPDATE users SET verified = 1 WHERE email = ?').run(email).changes > 0;
}

function bumpReceiveIndex(email) {
  const tx = get();
  tx.prepare('UPDATE users SET receive_index = receive_index + 1 WHERE email = ?').run(email);
  return tx.prepare('SELECT receive_index FROM users WHERE email = ?').get(email).receive_index;
}

// ── OTPs ─────────────────────────────────────────────────────────────────────

function upsertOtp({ email, purpose, codeHash, expiresAt }) {
  return get()
    .prepare(
      `INSERT OR REPLACE INTO otps (email, purpose, code_hash, expires_at, attempts)
       VALUES (?, ?, ?, ?, 0)`
    )
    .run(email, purpose, codeHash, expiresAt);
}

function getOtp(email, purpose) {
  return get().prepare('SELECT * FROM otps WHERE email = ? AND purpose = ?').get(email, purpose) || null;
}

function incrementOtpAttempts(email, purpose) {
  return get()
    .prepare('UPDATE otps SET attempts = attempts + 1 WHERE email = ? AND purpose = ?')
    .run(email, purpose);
}

function deleteOtp(email, purpose) {
  return get().prepare('DELETE FROM otps WHERE email = ? AND purpose = ?').run(email, purpose);
}

module.exports = {
  init,
  get,
  createUser,
  findByEmail,
  findByAlias,
  setVerified,
  bumpReceiveIndex,
  upsertOtp,
  getOtp,
  incrementOtpAttempts,
  deleteOtp,
};
