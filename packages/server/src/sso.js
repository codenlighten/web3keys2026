'use strict';

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { bsv } = require('@web3keys/wallet-core');
const { schemas } = require('@web3keys/shared');
const { config } = require('./config');
const { validate } = require('./middleware');
const { getRedis, hasRedis } = require('./redis');

/**
 * Backend for the SmartLedger Login SDK (packages/web/public/sl-login.js) — the
 * "Sign in with SmartLedger Wallet" authority endpoints. Third-party apps redirect users
 * to the wallet's /login (or /attest) approval page; the user signs a challenge with their
 * IDENTITY key in the browser; the relying app then verifies here.
 *
 * These endpoints only VERIFY user-supplied signatures (bsv signed messages) and manage
 * opaque SSO session tokens — no wallet keys are involved (non-custodial).
 */
const router = express.Router();
const SSO_TTL = Number(process.env.SSO_TTL_SEC || 3600);
const mem = new Map(); // token -> { address, domain, exp }  (fallback when no Redis)
const tkey = (t) => `sso:${t}`;

function makeLimiter(opts) {
  if (config.env === 'test') return (req, res, next) => next();
  const cfg = { standardHeaders: true, legacyHeaders: false, ...opts };
  if (hasRedis()) {
    const { default: RedisStore } = require('rate-limit-redis');
    cfg.store = new RedisStore({ sendCommand: (...a) => getRedis().call(...a) });
  }
  return rateLimit(cfg);
}
const verifyLimiter = makeLimiter({ windowMs: 60 * 1000, max: 60 });
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function verifyMessage(payload, address, signature) {
  try {
    return new bsv.Message(payload).verify(new bsv.Address(address), signature);
  } catch {
    return false;
  }
}

async function putSession(token, rec) {
  if (hasRedis()) await getRedis().set(tkey(token), JSON.stringify(rec), 'EX', SSO_TTL);
  else mem.set(token, rec);
}
async function getSession(token) {
  if (hasRedis()) {
    const v = await getRedis().get(tkey(token));
    return v ? JSON.parse(v) : null;
  }
  const r = mem.get(token);
  if (r && r.exp * 1000 < Date.now()) {
    mem.delete(token);
    return null;
  }
  return r || null;
}
async function delSession(token) {
  if (hasRedis()) await getRedis().del(tkey(token));
  else mem.delete(token);
}

// SLLogin: verify a sign-in signature → issue an opaque session token.
router.post(
  '/api/verify-login',
  verifyLimiter,
  validate(schemas.ssoVerifyLogin),
  h(async (req, res) => {
    const { address, signature, challenge, domain } = req.body;
    const payload = `SmartLedger Wallet sign-in v1\nDomain: ${domain}\nNonce: ${challenge}`;
    if (!verifyMessage(payload, address, signature)) {
      return res.json({ valid: false, reason: 'invalid_signature' });
    }
    const token = crypto.randomBytes(24).toString('hex');
    const exp = Math.floor(Date.now() / 1000) + SSO_TTL;
    await putSession(token, { address, domain, exp });
    res.json({ valid: true, token, exp, address });
  })
);

router.post(
  '/api/check-session',
  validate(schemas.ssoCheckSession),
  h(async (req, res) => {
    const s = await getSession(req.body.token);
    if (!s) return res.json({ valid: false });
    res.json({ valid: true, address: s.address, exp: s.exp });
  })
);

router.post(
  '/api/revoke-session',
  validate(schemas.ssoRevokeSession),
  h(async (req, res) => {
    await delSession(req.body.token);
    res.json({ revoked: true });
  })
);

// SLAttest: verify a signature over an arbitrary payload (no session issued).
router.post(
  '/api/verify-attest',
  verifyLimiter,
  validate(schemas.ssoVerifyAttest),
  h(async (req, res) => {
    const { address, signature, payload, app, domain, nonce } = req.body;
    const signedMessage =
      `SmartLedger Wallet attest v1\nApp: ${app || domain}\nDomain: ${domain}` +
      `\nNonce: ${nonce}\nPayload: ${payload}`;
    if (!verifyMessage(signedMessage, address, signature)) {
      return res.json({ valid: false, reason: 'invalid_signature' });
    }
    res.json({ valid: true, signedMessage });
  })
);

module.exports = { router };
