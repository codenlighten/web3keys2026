'use strict';

const jwt = require('jsonwebtoken');
const { config } = require('./config');
const { getRedis, hasRedis } = require('./redis');

/**
 * Session manager.
 *
 * - A JWT carries stateless auth (verifiable on any node).
 * - A SESSION RECORD (Redis if configured, else in-memory) enables cross-node
 *   revocation (logout) and expiry — the JWT is only honoured if its session record
 *   still exists.
 * - An IN-MEMORY per-node VAULT holds the user's unlocked Wallet so signing doesn't
 *   need the password each request. NOTE: this is per-node (Phase 2's threshold custody
 *   removes server-side keys entirely, eliminating the cross-node concern). Until then,
 *   send requests must hit the node that holds the unlock (sticky sessions).
 */
const vault = new Map(); // sid -> { wallet, email, expiresAt }
const memSessions = new Map(); // sid -> { email, expiresAt } (fallback when no Redis)

const ttlSec = Math.floor(config.sessionTtlMs / 1000);
const skey = (sid) => `sess:${sid}`;

function issueToken(email) {
  const sid = `${email}:${Date.now()}:${Math.floor(Math.random() * 1e9)}`;
  const token = jwt.sign({ email, sid }, config.jwtSecret, { expiresIn: ttlSec });
  return { token, sid };
}

function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}

/** Create the cross-node session record. */
async function createSession(sid, email) {
  if (hasRedis()) {
    await getRedis().set(skey(sid), email, 'EX', ttlSec);
  } else {
    memSessions.set(sid, { email, expiresAt: Date.now() + config.sessionTtlMs });
  }
}

/** Return the session record (or null if missing/expired/revoked). */
async function getSession(sid) {
  if (hasRedis()) {
    const email = await getRedis().get(skey(sid));
    return email ? { email } : null;
  }
  const rec = memSessions.get(sid);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) {
    memSessions.delete(sid);
    return null;
  }
  return rec;
}

async function revokeSession(sid) {
  if (hasRedis()) await getRedis().del(skey(sid));
  else memSessions.delete(sid);
  vault.delete(sid);
}

/** Store an unlocked wallet for a session (per-node, in-memory only). */
function putWallet(sid, email, wallet) {
  vault.set(sid, { wallet, email, expiresAt: Date.now() + config.sessionTtlMs });
}

/** Retrieve an unlocked wallet if still live on this node. */
function getWallet(sid) {
  const entry = vault.get(sid);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    vault.delete(sid);
    return null;
  }
  return entry.wallet;
}

/** Periodically evict expired unlocked wallets (defensive seed hygiene). */
function startReaper() {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [sid, entry] of vault) {
      if (now > entry.expiresAt) vault.delete(sid);
    }
    for (const [sid, rec] of memSessions) {
      if (now > rec.expiresAt) memSessions.delete(sid);
    }
  }, 60 * 1000);
  timer.unref();
  return timer;
}

module.exports = {
  issueToken,
  verifyToken,
  createSession,
  getSession,
  revokeSession,
  putWallet,
  getWallet,
  startReaper,
};
