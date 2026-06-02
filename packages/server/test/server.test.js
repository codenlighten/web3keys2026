'use strict';

// Isolated, offline test config BEFORE requiring server modules.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.WALLET_DOMAIN = 'web3keys.com';
process.env.BASE_URL = 'https://web3keys.com';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { authenticator } = require('otplib');

const security = require('../src/security');
const db = require('../src/db');
const { createApp } = require('../src/app');
const { Wallet } = require('@web3keys/wallet-core');

// Deterministic OTP (svc calls security.generateOtp() via the namespace).
security.generateOtp = () => '123456';

let server;
let base;

before(async () => {
  await db.init();
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) server.close();
  await require('../src/db/pool')
    .close()
    .catch(() => {});
  await require('../src/redis')
    .closeRedis()
    .catch(() => {});
});

async function api(method, path, body, token) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// A non-custodial registration: the CLIENT makes the wallet and sends only public data.
function regBody(email, password) {
  const wallet = Wallet.generate();
  const d = wallet.describe();
  return {
    wallet,
    body: {
      email,
      password,
      identityKey: wallet.identity.identityKey,
      financeXpub: d.finance.xpub,
      tokensXpub: d.tokens.xpub,
      identityXpub: d.identity.xpub,
    },
  };
}

async function registerVerifyLogin(email, password = 'password1234') {
  const { wallet, body } = regBody(email, password);
  await api('POST', '/api/auth/register', body);
  await api('POST', '/api/auth/verify', { email, code: '123456' });
  const login = await api('POST', '/api/auth/login', { email, password });
  return { wallet, token: login.json.token, body };
}

test('registration is non-custodial: client supplies xpubs, server returns NO seed', async () => {
  const email = 'alice@example.com';
  const { wallet, body } = regBody(email, 'hunter2hunter2');
  const reg = await api('POST', '/api/auth/register', body);
  assert.equal(reg.status, 201);
  assert.ok(!reg.json.mnemonic && !reg.json.recoveryShare); // server never had the seed
  assert.equal(reg.json.profile.paymail, 'alice@web3keys.com');
  // the profile's deposit address derives from the client-supplied xpub
  assert.equal(reg.json.profile.address, wallet.keyManager.address('finance'));
});

test('the database holds NO key material for a user', async () => {
  const email = 'nokey@example.com';
  const { wallet } = await registerVerifyLogin(email);
  const user = await db.findByEmail(email);
  const backup = await db.getBackup(user.id);
  const dump = JSON.stringify({ user, backup });
  assert.ok(!dump.includes(wallet.mnemonic), 'mnemonic must never be server-side');
  // only public material is stored
  assert.ok(user.finance_xpub.startsWith('xpub'));
  assert.equal(backup, null);
});

test('register → verify → login (account auth, no wallet unlock)', async () => {
  const email = 'bob@example.com';
  const password = 'password1234';
  const { body } = regBody(email, password);
  await api('POST', '/api/auth/register', body);

  assert.equal((await api('POST', '/api/auth/login', { email, password })).status, 403); // unverified
  assert.equal((await api('POST', '/api/auth/verify', { email, code: '123456' })).status, 200);

  const login = await api('POST', '/api/auth/login', { email, password });
  assert.equal(login.status, 200);
  assert.ok(login.json.token);
  assert.equal(
    (await api('POST', '/api/auth/login', { email, password: 'wrong-pass' })).status,
    401
  );

  const profile = await api('GET', '/api/wallet/profile', null, login.json.token);
  assert.equal(profile.json.paymail, 'bob@web3keys.com');
  assert.equal((await api('GET', '/api/wallet/profile')).status, 401);
});

test('removed custodial endpoints are gone (no export/recover/server-send)', async () => {
  const { token } = await registerVerifyLogin('gone@example.com');
  assert.equal((await api('GET', '/api/wallet/export', null, token)).status, 404);
  assert.equal(
    (
      await api('POST', '/api/auth/recover', {
        email: 'x',
        recoveryShare: 'y',
        newPassword: 'zzzzzzzz',
      })
    ).status,
    404
  );
  assert.equal(
    (await api('POST', '/api/wallet/send', { to: 'x', satoshis: 1 }, token)).status,
    404
  );
});

test('encrypted backup is opaque store/retrieve (server cannot decrypt)', async () => {
  const { token } = await registerVerifyLogin('vault@example.com');
  assert.equal((await api('GET', '/api/backup', null, token)).status, 404); // none yet
  const blob = { scheme: 'passkey-prf-aesgcm', ciphertext: 'a1b2c3'.repeat(20) };
  assert.equal((await api('PUT', '/api/backup', blob, token)).status, 200);
  const got = await api('GET', '/api/backup', null, token);
  assert.equal(got.status, 200);
  assert.equal(got.json.scheme, blob.scheme);
  assert.equal(got.json.ciphertext, blob.ciphertext);
});

test('receive address rotates (HD), distinct valid addresses', async () => {
  const { token } = await registerVerifyLogin('rita@example.com');
  const a0 = await api('GET', '/api/wallet/address', null, token);
  assert.equal(a0.json.index, 0);
  const rotated = await api('POST', '/api/wallet/address/new', null, token);
  assert.equal(rotated.json.index, 1);
  assert.notEqual(rotated.json.address, a0.json.address);
  assert.equal(
    (await api('GET', '/api/wallet/address', null, token)).json.address,
    rotated.json.address
  );
});

test('local paymail resolves to an address (for client-side payment)', async () => {
  await registerVerifyLogin('payee@example.com');
  const { token } = await registerVerifyLogin('payer@example.com');
  const r = await api(
    'POST',
    '/api/paymail/resolve',
    { to: 'payee@web3keys.com', satoshis: 1000 },
    token
  );
  assert.equal(r.status, 200);
  assert.ok(/^1[1-9A-HJ-NP-Za-km-z]+$/.test(r.json.address));
});

test('paymail discovery + pki + payment destination', async () => {
  await registerVerifyLogin('charlie@example.com');
  const disco = await api('GET', '/.well-known/bsvalias');
  assert.equal(disco.json.bsvalias, '1.0');
  const pki = await api('GET', '/api/paymail/id/charlie@web3keys.com');
  assert.ok(/^0[23][0-9a-f]{64}$/.test(pki.json.pubkey));
  const dest = await api('POST', '/api/paymail/address/charlie@web3keys.com', {
    senderHandle: 'x@y.com',
  });
  assert.ok(/^76a914[0-9a-f]{40}88ac$/.test(dest.json.output));
});

test('chain sync detects deposits → notification + history (idempotent)', async () => {
  const { MockProvider } = require('../../wallet-core/test/helpers/MockProvider');
  const chainsync = require('../src/chainsync');
  const svc = require('../src/walletService');
  const email = 'deb@example.com';
  const { token } = await registerVerifyLogin(email);
  const user = await db.findByEmail(email);

  const provider = new MockProvider();
  provider.seedUtxo(svc.depositAddress(user, 0), { satoshis: 5000 });
  assert.equal((await chainsync.syncUserDeposits(user, { provider, gapLimit: 5 })).length, 1);

  const notifs = await api('GET', '/api/notifications', null, token);
  assert.equal(notifs.json.notifications[0].type, 'deposit');
  const hist = await api('GET', '/api/wallet/history', null, token);
  assert.ok(hist.json.transactions.some((t) => t.direction === 'in' && t.amountSats === 5000));
  assert.equal((await chainsync.syncUserDeposits(user, { provider, gapLimit: 5 })).length, 0);
});

test('TOTP 2FA: setup → enable → enforced at login', async () => {
  const email = 'tina@example.com';
  const password = 'password1234';
  const { token } = await registerVerifyLogin(email, password);
  const setup = await api('POST', '/api/2fa/setup', null, token);
  assert.ok(setup.json.otpauth.startsWith('otpauth://totp/'));
  await api('POST', '/api/2fa/enable', { code: authenticator.generate(setup.json.secret) }, token);

  const noCode = await api('POST', '/api/auth/login', { email, password });
  assert.equal(noCode.status, 401);
  assert.ok(noCode.json.twoFactorRequired);
  const ok = await api('POST', '/api/auth/login', {
    email,
    password,
    totpCode: authenticator.generate(setup.json.secret),
  });
  assert.equal(ok.status, 200);
});

test('input validation + security headers', async () => {
  // missing xpubs → 400
  assert.equal(
    (await api('POST', '/api/auth/register', { email: 'a@b.co', password: 'password1234' })).status,
    400
  );
  assert.equal(
    (await api('POST', '/api/auth/register', { email: 'bad', password: 'x' })).status,
    400
  );
  const res = await fetch(base + '/health');
  assert.ok(res.headers.get('content-security-policy'));
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('account lockout after repeated failed logins (429)', async () => {
  const email = 'liam@example.com';
  const password = 'password1234';
  await require('../src/lockout').clear(email);
  await registerVerifyLogin(email, password);
  for (let i = 0; i < 5; i++) {
    assert.equal(
      (await api('POST', '/api/auth/login', { email, password: 'wrongpassword' })).status,
      401
    );
  }
  const locked = await api('POST', '/api/auth/login', { email, password });
  assert.equal(locked.status, 429);
});

test('GDPR: account data export returns the user’s data', async () => {
  const { token } = await registerVerifyLogin('export@example.com');
  const exp = await api('GET', '/api/account/export', null, token);
  assert.equal(exp.status, 200);
  assert.equal(exp.json.account.paymail, 'export@web3keys.com');
  assert.ok(exp.json.account.financeXpub.startsWith('xpub'));
  assert.ok(Array.isArray(exp.json.transactions));
  assert.ok(Array.isArray(exp.json.audit));
});

test('GDPR: account deletion requires the password and erases the user', async () => {
  const email = 'erase@example.com';
  const password = 'password1234';
  const { token } = await registerVerifyLogin(email, password);

  // wrong password is rejected
  assert.equal(
    (await api('DELETE', '/api/account', { password: 'nope-nope-nope' }, token)).status,
    401
  );

  const del = await api('DELETE', '/api/account', { password }, token);
  assert.equal(del.status, 200);
  assert.ok(del.json.deleted);

  // user is gone: cannot log in, and the old token is invalid
  assert.equal((await api('POST', '/api/auth/login', { email, password })).status, 401);
  assert.equal((await api('GET', '/api/wallet/profile', null, token)).status, 401);
  assert.equal(await db.findByEmail(email), null);
});

test('duplicate registration is rejected', async () => {
  const { body } = regBody('dupe@example.com', 'password1234');
  assert.equal((await api('POST', '/api/auth/register', body)).status, 201);
  const { body: body2 } = regBody('dupe@example.com', 'password1234');
  assert.equal((await api('POST', '/api/auth/register', body2)).status, 409);
});
