'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { schemas } = require('@web3keys/shared');
const { config } = require('./config');
const db = require('./db');
const svc = require('./walletService');
const session = require('./session');
const twofa = require('./twofa');
const lockout = require('./lockout');
const { validate } = require('./middleware');
const { ServiceError } = require('./errors');
const { getRedis, hasRedis } = require('./redis');

const router = express.Router();

// Shared, cross-node rate limiting via Redis when configured; in-memory otherwise.
// Disabled under test so suites can make many requests from one IP deterministically.
function makeLimiter(opts) {
  if (config.env === 'test') return (req, res, next) => next();
  const cfg = { standardHeaders: true, legacyHeaders: false, ...opts };
  if (hasRedis()) {
    const { default: RedisStore } = require('rate-limit-redis');
    cfg.store = new RedisStore({ sendCommand: (...args) => getRedis().call(...args) });
  }
  return rateLimit(cfg);
}

const authLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 30 });

/** Wrap async handlers so rejections hit the error middleware. */
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const audit = (req, action, email, detail) =>
  db.audit({ email, action, ip: req.ip, detail }).catch(() => {});

// ── auth ────────────────────────────────────────────────────────────────────

router.post(
  '/api/auth/register',
  authLimiter,
  validate(schemas.register),
  h(async (req, res) => {
    const { email, password } = req.body;
    const result = await svc.register({ email, password });
    audit(req, 'register', email);
    res.status(201).json(result);
  })
);

router.post(
  '/api/auth/verify',
  authLimiter,
  validate(schemas.verify),
  h(async (req, res) => {
    const { email, code } = req.body;
    const profile = await svc.verifyRegistration({ email, code });
    audit(req, 'verify', email);
    res.json({ verified: true, profile });
  })
);

router.post(
  '/api/auth/resend',
  authLimiter,
  validate(schemas.resend),
  h(async (req, res) => {
    const { email } = req.body;
    if (await db.findByEmail(email)) await svc.issueOtp(email, 'register');
    res.json({ otpSent: true }); // do not leak whether the email exists
  })
);

router.post(
  '/api/auth/login',
  authLimiter,
  validate(schemas.login),
  h(async (req, res) => {
    const { email, password, totpCode } = req.body;
    await lockout.assertNotLocked(email);

    let user;
    let wallet;
    try {
      ({ user, wallet } = await svc.unlock({ email, password }));
    } catch (e) {
      if (e.status === 401) {
        await lockout.recordFailure(email);
        audit(req, 'login_fail', email, { reason: 'credentials' });
      }
      throw e;
    }

    // Enforce 2FA when enabled. A missing code (twoFactorRequired) is the expected first
    // step and is NOT counted as a failure; an invalid code is.
    try {
      twofa.verifyLogin(user, totpCode);
    } catch (e) {
      if (!(e.extra && e.extra.twoFactorRequired)) {
        await lockout.recordFailure(email);
        audit(req, 'login_fail', email, { reason: '2fa' });
      }
      throw e;
    }

    await lockout.clear(email);
    const { token, sid } = session.issueToken(user.email);
    await session.createSession(sid, user.email);
    session.putWallet(sid, user.email, wallet);
    audit(req, 'login_success', email);
    res.json({ token, profile: svc.publicProfile(user) });
  })
);

router.post(
  '/api/auth/recover',
  authLimiter,
  validate(schemas.recover),
  h(async (req, res) => {
    const { email, recoveryShare, newPassword } = req.body;
    const result = await svc.recover({ email, recoveryShare, newPassword });
    await lockout.clear(email);
    audit(req, 'recover', email);
    res.json(result);
  })
);

// ── authenticated middleware ──────────────────────────────────────────────────

const authed = h(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const claims = token && session.verifyToken(token);
  if (!claims) return res.status(401).json({ error: 'unauthorized' });
  // The JWT is only honoured while its session record exists (enables revocation).
  const rec = await session.getSession(claims.sid);
  if (!rec) return res.status(401).json({ error: 'session revoked or expired' });
  req.claims = claims;
  req.user = await db.findByEmail(claims.email);
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  next();
});

router.post(
  '/api/auth/logout',
  authed,
  h(async (req, res) => {
    await session.revokeSession(req.claims.sid);
    res.json({ ok: true });
  })
);

// ── two-factor auth ────────────────────────────────────────────────────────────

router.post(
  '/api/2fa/setup',
  authed,
  h(async (req, res) => {
    const { otpauth, secret } = await twofa.setup(req.user);
    audit(req, '2fa_setup', req.user.email);
    res.json({ otpauth, secret });
  })
);

router.post(
  '/api/2fa/enable',
  authed,
  validate(schemas.twoFactorEnable),
  h(async (req, res) => {
    const result = await twofa.enable(req.user, req.body.code);
    audit(req, '2fa_enable', req.user.email);
    res.json(result);
  })
);

router.post(
  '/api/2fa/disable',
  authed,
  validate(schemas.twoFactorDisable),
  h(async (req, res) => {
    const result = await twofa.disable(req.user, req.body.code);
    audit(req, '2fa_disable', req.user.email);
    res.json(result);
  })
);

// ── wallet ────────────────────────────────────────────────────────────────────

router.get('/api/wallet/profile', authed, (req, res) => {
  res.json(svc.publicProfile(req.user));
});

router.get('/api/wallet/address', authed, (req, res) => {
  res.json({
    address: svc.receiveAddress(req.user),
    index: req.user.receive_index || 0,
    paymail: svc.publicProfile(req.user).paymail,
  });
});

// Rotate to a fresh receive address (privacy; funds at any prior address remain spendable).
router.post(
  '/api/wallet/address/new',
  authed,
  h(async (req, res) => {
    res.json(await svc.rotateReceiveAddress(req.user));
  })
);

router.get(
  '/api/wallet/balance',
  authed,
  h(async (req, res) => {
    res.json(await svc.getBalance(req.user));
  })
);

router.post(
  '/api/wallet/send',
  authed,
  validate(schemas.send),
  h(async (req, res) => {
    const wallet = session.getWallet(req.claims.sid);
    if (!wallet) throw new ServiceError('session expired; please log in again', 401);
    const { to, satoshis } = req.body;
    const result = await svc.send(wallet, { to, satoshis });
    await db
      .insertTransaction({
        txid: result.txid,
        userId: req.user.id,
        direction: 'out',
        amountSats: result.satoshis,
        address: result.to,
        status: 'broadcast',
      })
      .catch(() => {});
    audit(req, 'send', req.user.email, {
      to: result.to,
      satoshis: result.satoshis,
      txid: result.txid,
    });
    res.json(result);
  })
);

router.get(
  '/api/wallet/history',
  authed,
  h(async (req, res) => {
    const transactions = await db.listTransactions(req.user.id, { limit: 100 });
    res.json({ transactions });
  })
);

// Escape hatch: reveal the full mnemonic so the user can move to self-custody. Requires
// an active (unlocked) session, since the seed only exists in the session vault.
router.get('/api/wallet/export', authed, (req, res) => {
  const wallet = session.getWallet(req.claims.sid);
  if (!wallet) throw new ServiceError('session expired; please log in again', 401);
  audit(req, 'export', req.user.email);
  res.json({
    mnemonic: wallet.mnemonic,
    warning: 'Anyone with these words controls your funds. Store them offline.',
  });
});

module.exports = { router, authed };
