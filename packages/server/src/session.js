'use strict';

const crypto = require('crypto');
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
 * There is NO server-side key vault — the wallet is non-custodial, so the server never
 * holds a seed or signs. Sessions only authorize read-only data, broadcasting, and
 * account actions.
 */
const memSessions = new Map(); // sid -> { email, expiresAt } (fallback when no Redis)

const ttlSec = Math.floor(config.sessionTtlMs / 1000);
const skey = (sid) => `sess:${sid}`;

function issueToken(email) {
  // Cryptographically-random session id (the revocation key) — never guessable.
  const sid = crypto.randomUUID();
  const token = jwt.sign({ email, sid }, config.jwtSecret, { expiresIn: ttlSec });
  return { token, sid };
}

function verifyToken(token) {
  try {
    // Pin the algorithm so a forged token can't downgrade/confuse the verifier.
    return jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
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
}

/** Periodically evict expired in-memory session records. */
function startReaper() {
  const timer = setInterval(() => {
    const now = Date.now();
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
  startReaper,
};
