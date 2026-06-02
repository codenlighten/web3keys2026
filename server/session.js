'use strict';

const jwt = require('jsonwebtoken');
const { config } = require('./config');

/**
 * Session manager.
 *
 * A JWT identifies the session (stateless auth). Separately, an IN-MEMORY vault holds
 * the user's unlocked Wallet for the session's lifetime so signing operations don't
 * need the password on every request. The unlocked seed therefore lives only in RAM,
 * only while a session is active, and is wiped on logout/expiry. It is never persisted.
 */
const vault = new Map(); // sid -> { wallet, email, expiresAt }

function issueToken(email) {
  const sid = `${email}:${Date.now()}:${Math.floor(Math.random() * 1e9)}`;
  const token = jwt.sign({ email, sid }, config.jwtSecret, {
    expiresIn: Math.floor(config.sessionTtlMs / 1000),
  });
  return { token, sid };
}

function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}

/** Store an unlocked wallet for a session. */
function putWallet(sid, email, wallet) {
  vault.set(sid, { wallet, email, expiresAt: Date.now() + config.sessionTtlMs });
}

/** Retrieve an unlocked wallet if the session is still live. */
function getWallet(sid) {
  const entry = vault.get(sid);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    vault.delete(sid);
    return null;
  }
  return entry.wallet;
}

function clear(sid) {
  vault.delete(sid);
}

/** Periodically evict expired unlocked wallets (defensive seed hygiene). */
function startReaper() {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [sid, entry] of vault) {
      if (now > entry.expiresAt) vault.delete(sid);
    }
  }, 60 * 1000);
  timer.unref();
  return timer;
}

module.exports = { issueToken, verifyToken, putWallet, getWallet, clear, startReaper };
