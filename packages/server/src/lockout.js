'use strict';

const { getRedis, hasRedis } = require('./redis');
const { ServiceError } = require('./errors');

/**
 * Account lockout / brute-force throttle, keyed by email. Backed by Redis (shared across
 * nodes) with an in-memory fallback. After MAX failures within WINDOW, the account is
 * locked for LOCK seconds.
 */
const MAX = Number(process.env.LOCKOUT_MAX || 5);
const WINDOW = Number(process.env.LOCKOUT_WINDOW_SEC || 900);
const LOCK = Number(process.env.LOCKOUT_SECONDS || 900);

const mem = new Map(); // email -> { fails, windowUntil, lockUntil }

const failKey = (e) => `lockfail:${e}`;
const lockKey = (e) => `lock:${e}`;

async function assertNotLocked(email) {
  if (hasRedis()) {
    const ttl = await getRedis().ttl(lockKey(email));
    if (ttl > 0) throw new ServiceError('Account temporarily locked', 429, { retryAfterSec: ttl });
    return;
  }
  const e = mem.get(email);
  if (e && e.lockUntil && e.lockUntil > Date.now()) {
    throw new ServiceError('Account temporarily locked', 429, {
      retryAfterSec: Math.ceil((e.lockUntil - Date.now()) / 1000),
    });
  }
}

async function recordFailure(email) {
  if (hasRedis()) {
    const r = getRedis();
    const n = await r.incr(failKey(email));
    if (n === 1) await r.expire(failKey(email), WINDOW);
    if (n >= MAX) {
      await r.set(lockKey(email), '1', 'EX', LOCK);
      await r.del(failKey(email));
    }
    return;
  }
  const now = Date.now();
  const e = mem.get(email) || { fails: 0, windowUntil: now + WINDOW * 1000 };
  if (now > e.windowUntil) {
    e.fails = 0;
    e.windowUntil = now + WINDOW * 1000;
  }
  e.fails += 1;
  if (e.fails >= MAX) {
    e.lockUntil = now + LOCK * 1000;
    e.fails = 0;
  }
  mem.set(email, e);
}

async function clear(email) {
  if (hasRedis()) {
    await getRedis().del(failKey(email), lockKey(email));
    return;
  }
  mem.delete(email);
}

module.exports = { assertNotLocked, recordFailure, clear };
