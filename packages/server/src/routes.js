'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const svc = require('./walletService');
const session = require('./session');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

/** Wrap async handlers so rejections hit the error middleware. */
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── auth ────────────────────────────────────────────────────────────────────

router.post(
  '/api/auth/register',
  authLimiter,
  h(async (req, res) => {
    const { email, password } = req.body || {};
    const result = await svc.register({ email, password });
    res.status(201).json(result);
  })
);

router.post(
  '/api/auth/verify',
  authLimiter,
  h(async (req, res) => {
    const { email, code } = req.body || {};
    const profile = svc.verifyRegistration({ email, code });
    res.json({ verified: true, profile });
  })
);

router.post(
  '/api/auth/resend',
  authLimiter,
  h(async (req, res) => {
    const email = String((req.body || {}).email || '')
      .trim()
      .toLowerCase();
    if (db.findByEmail(email)) await svc.issueOtp(email, 'register');
    res.json({ otpSent: true }); // do not leak whether the email exists
  })
);

router.post(
  '/api/auth/login',
  authLimiter,
  h(async (req, res) => {
    const { email, password } = req.body || {};
    const { user, wallet } = svc.unlock({ email, password });
    const { token, sid } = session.issueToken(user.email);
    session.putWallet(sid, user.email, wallet);
    res.json({ token, profile: svc.publicProfile(user) });
  })
);

// ── authenticated middleware ──────────────────────────────────────────────────

function authed(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const claims = token && session.verifyToken(token);
  if (!claims) return res.status(401).json({ error: 'unauthorized' });
  req.claims = claims;
  req.user = db.findByEmail(claims.email);
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  next();
}

router.post('/api/auth/logout', authed, (req, res) => {
  session.clear(req.claims.sid);
  res.json({ ok: true });
});

// ── wallet ────────────────────────────────────────────────────────────────────

router.get('/api/wallet/profile', authed, (req, res) => {
  res.json(svc.publicProfile(req.user));
});

router.get('/api/wallet/address', authed, (req, res) => {
  res.json({ address: svc.depositAddress(req.user), paymail: svc.publicProfile(req.user).paymail });
});

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
  h(async (req, res) => {
    const wallet = session.getWallet(req.claims.sid);
    if (!wallet) return res.status(401).json({ error: 'session expired; please log in again' });
    const { to, satoshis } = req.body || {};
    const result = await svc.send(wallet, { to, satoshis });
    res.json(result);
  })
);

module.exports = { router, authed };
