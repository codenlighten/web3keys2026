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
const { recordEvent } = require('./metrics');
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

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const audit = (req, action, email, detail) =>
  db.audit({ email, action, ip: req.ip, detail }).catch(() => {});

// ── auth (account only — keys are client-side, non-custodial) ─────────────────────

router.post(
  '/api/auth/register',
  authLimiter,
  validate(schemas.register),
  h(async (req, res) => {
    const result = await svc.register(req.body);
    audit(req, 'register', req.body.email);
    recordEvent('register', 'ok');
    res.status(201).json(result);
  })
);

router.post(
  '/api/auth/verify',
  authLimiter,
  validate(schemas.verify),
  h(async (req, res) => {
    const profile = await svc.verifyRegistration(req.body);
    audit(req, 'verify', req.body.email);
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
    res.json({ otpSent: true });
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
    try {
      ({ user } = await svc.authenticate({ email, password }));
    } catch (e) {
      if (e.status === 401) {
        await lockout.recordFailure(email);
        audit(req, 'login_fail', email, { reason: 'credentials' });
        recordEvent('login', 'fail');
      }
      throw e;
    }

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
    audit(req, 'login_success', email);
    recordEvent('login', 'success');
    res.json({ token, profile: svc.publicProfile(user) });
  })
);

// ── authenticated middleware ──────────────────────────────────────────────────

const authed = h(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const tok = header.startsWith('Bearer ') ? header.slice(7) : null;
  const claims = tok && session.verifyToken(tok);
  if (!claims) return res.status(401).json({ error: 'unauthorized' });
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
    const r = await twofa.setup(req.user);
    audit(req, '2fa_setup', req.user.email);
    res.json(r);
  })
);
router.post(
  '/api/2fa/enable',
  authed,
  validate(schemas.twoFactorEnable),
  h(async (req, res) => {
    const r = await twofa.enable(req.user, req.body.code);
    audit(req, '2fa_enable', req.user.email);
    res.json(r);
  })
);
router.post(
  '/api/2fa/disable',
  authed,
  validate(schemas.twoFactorDisable),
  h(async (req, res) => {
    const r = await twofa.disable(req.user, req.body.code);
    audit(req, '2fa_disable', req.user.email);
    res.json(r);
  })
);

// ── wallet (read-only data + broadcast; NO server signing) ────────────────────────

router.get('/api/wallet/profile', authed, (req, res) => res.json(svc.publicProfile(req.user)));

router.get('/api/wallet/address', authed, (req, res) => {
  res.json({
    address: svc.receiveAddress(req.user),
    index: req.user.receive_index || 0,
    paymail: svc.publicProfile(req.user).paymail,
  });
});

router.post(
  '/api/wallet/address/new',
  authed,
  h(async (req, res) => res.json(await svc.rotateReceiveAddress(req.user)))
);

router.get(
  '/api/wallet/balance',
  authed,
  h(async (req, res) => res.json(await svc.getBalance(req.user)))
);

// Spendable UTXOs (tagged with derivation index) for CLIENT-SIDE signing.
router.get(
  '/api/wallet/utxos',
  authed,
  h(async (req, res) => res.json({ utxos: await svc.getSpendableUtxos(req.user) }))
);

// Resolve a recipient (address / local paymail / external paymail) to {address|script}.
router.post(
  '/api/paymail/resolve',
  authed,
  validate(schemas.paymailResolve),
  h(async (req, res) => {
    const dest = await svc.resolveRecipient(req.body.to, {
      satoshis: req.body.satoshis,
      senderPaymail: svc.publicProfile(req.user).paymail,
    });
    res.json(dest);
  })
);

// Broadcast a CLIENT-SIGNED transaction; record it in history.
router.post(
  '/api/tx/broadcast',
  authed,
  validate(schemas.broadcast),
  h(async (req, res) => {
    const { rawHex, to, satoshis } = req.body;
    const txid = await svc.broadcast(rawHex);
    await db
      .insertTransaction({
        txid,
        userId: req.user.id,
        direction: 'out',
        amountSats: satoshis || 0,
        address: to || null,
        status: 'broadcast',
      })
      .catch(() => {});
    audit(req, 'broadcast', req.user.email, { txid, to, satoshis });
    recordEvent('broadcast', 'ok');
    res.json({ txid });
  })
);

router.get(
  '/api/wallet/history',
  authed,
  h(async (req, res) =>
    res.json({ transactions: await db.listTransactions(req.user.id, { limit: 100 }) })
  )
);

router.get(
  '/api/ordinals',
  authed,
  h(async (req, res) => res.json({ ordinals: await svc.listOrdinals(req.user) }))
);

// ── notifications ────────────────────────────────────────────────────────────

router.get(
  '/api/notifications',
  authed,
  h(async (req, res) => {
    const unreadOnly = req.query.unread === 'true';
    res.json({ notifications: await db.listNotifications(req.user.id, { unreadOnly }) });
  })
);

router.post(
  '/api/notifications/:id/read',
  authed,
  h(async (req, res) =>
    res.json({ ok: await db.markNotificationRead(req.user.id, Number(req.params.id)) })
  )
);

// ── account (GDPR: data export + erasure) ─────────────────────────────────────────

router.get(
  '/api/account/export',
  authed,
  h(async (req, res) => {
    const u = req.user;
    res.json({
      account: {
        email: u.email,
        paymail: svc.publicProfile(u).paymail,
        alias: u.alias,
        identityKey: u.identity_pubkey,
        financeXpub: u.finance_xpub,
        tokensXpub: u.tokens_xpub,
        identityXpub: u.identity_xpub,
        verified: !!u.verified,
        createdAt: u.created_at,
      },
      transactions: await db.listTransactions(u.id, { limit: 10000 }),
      notifications: await db.listNotifications(u.id, { limit: 10000 }),
      backup: await db.getBackup(u.id),
      audit: await db.listAuditForEmail(u.email),
    });
  })
);

router.delete(
  '/api/account',
  authed,
  validate(schemas.deleteAccount),
  h(async (req, res) => {
    await svc.authenticate({ email: req.user.email, password: req.body.password }); // re-auth
    await db.deleteUser(req.user.id);
    await db.deleteAuditForEmail(req.user.email); // erase PII trail
    await session.revokeSession(req.claims.sid);
    res.json({ deleted: true });
  })
);

// ── encrypted backup (Tier 1) — opaque blob the server cannot decrypt ─────────────

router.put(
  '/api/backup',
  authed,
  validate(schemas.backupPut),
  h(async (req, res) => {
    await db.putBackup(req.user.id, req.body);
    audit(req, 'backup_put', req.user.email, { scheme: req.body.scheme });
    res.json({ ok: true });
  })
);

router.get(
  '/api/backup',
  authed,
  h(async (req, res) => {
    const backup = await db.getBackup(req.user.id);
    if (!backup) return res.status(404).json({ error: 'no backup' });
    res.json(backup);
  })
);

module.exports = { router, authed };
