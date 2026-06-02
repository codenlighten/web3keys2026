'use strict';

// Configure the server for an isolated, offline test BEFORE requiring its modules.
process.env.NODE_ENV = 'test';
process.env.DB_FILE = ':memory:';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.WALLET_DOMAIN = 'web3keys.com';
process.env.BASE_URL = 'https://web3keys.com';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const security = require('../src/security');
const shares = require('../src/shares');
const db = require('../src/db');
const { createApp } = require('../src/app');
const { threshold } = require('@web3keys/wallet-core');

// Deterministic OTP so we can verify without reading email. svc calls
// security.generateOtp() via the namespace, so overriding the property works.
security.generateOtp = () => '123456';

let server;
let base;

before(async () => {
  await db.init(); // run migrations against the in-memory (pg-mem) database
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
  // Close any real Postgres/Redis connections so the test process exits cleanly
  // (no-ops for the in-memory pg-mem path and when Redis is unconfigured).
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

test('share sealing: S2 (password) and S3 (master key) round-trip; wrong key fails', () => {
  const { user, service, ttp } = threshold.splitSeed(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  );
  // S2 sealed under password
  const s2 = shares.sealUserShare(service, 'correct horse');
  assert.equal(shares.openUserShare(s2, 'correct horse'), service);
  assert.throws(() => shares.openUserShare(s2, 'wrong'));
  // S3 sealed under master key
  const s3 = shares.sealTtpShare(ttp);
  assert.equal(shares.openTtpShare(s3), ttp);
  // sanity: the opened S2 + S3 still reconstruct, and so do user + S3
  assert.ok(
    threshold.reconstruct([shares.openUserShare(s2, 'correct horse'), shares.openTtpShare(s3)])
  );
  assert.ok(threshold.reconstruct([user, shares.openTtpShare(s3)]));
  // password verifier
  const v = security.hashPassword('s3cret!!');
  assert.ok(security.verifyPassword('s3cret!!', v));
  assert.ok(!security.verifyPassword('nope', v));
});

test('full flow: register → verify → login → profile → export escape-hatch', async () => {
  const email = 'alice@example.com';
  const password = 'hunter2hunter2';

  const reg = await api('POST', '/api/auth/register', { email, password });
  assert.equal(reg.status, 201);
  assert.ok(reg.json.recoveryShare && !reg.json.mnemonic); // S1 shown once, NO raw seed
  assert.equal(reg.json.profile.paymail, 'alice@web3keys.com');

  // cannot log in before verifying
  assert.equal((await api('POST', '/api/auth/login', { email, password })).status, 403);

  const ver = await api('POST', '/api/auth/verify', { email, code: '123456' });
  assert.equal(ver.status, 200);

  const login = await api('POST', '/api/auth/login', { email, password });
  assert.equal(login.status, 200);
  const token = login.json.token;

  // wrong password rejected (S2 won't open)
  assert.equal(
    (await api('POST', '/api/auth/login', { email, password: 'wrongwrong' })).status,
    401
  );

  const profile = await api('GET', '/api/wallet/profile', null, token);
  assert.equal(profile.status, 200);
  assert.ok(/^1[1-9A-HJ-NP-Za-km-z]+$/.test(profile.json.address));

  // export (escape hatch) reveals a 12-word seed that derives the SAME deposit address —
  // proving the 2-of-3 reconstruction yields the real wallet.
  const exp = await api('GET', '/api/wallet/export', null, token);
  assert.equal(exp.status, 200);
  assert.equal(exp.json.mnemonic.split(' ').length, 12);
  const { Wallet } = require('@web3keys/wallet-core');
  assert.equal(
    Wallet.fromMnemonic(exp.json.mnemonic).keyManager.address('finance'),
    profile.json.address
  );

  assert.equal((await api('GET', '/api/wallet/profile')).status, 401); // no token
});

test('recovery: recovery share + new password restores access; old password fails', async () => {
  const email = 'carol@example.com';
  const password = 'origpassword12';
  const reg = await api('POST', '/api/auth/register', { email, password });
  await api('POST', '/api/auth/verify', { email, code: '123456' });
  const recoveryShare = reg.json.recoveryShare;

  const addrBefore = await loginAddress(email, password);

  // recover with the share + a new password
  const newPassword = 'brandnewpass99';
  const rec = await api('POST', '/api/auth/recover', { email, recoveryShare, newPassword });
  assert.equal(rec.status, 200);
  assert.ok(rec.json.recoveryShare); // a fresh recovery share is issued
  assert.notEqual(rec.json.recoveryShare, recoveryShare); // old one consumed

  // old password no longer works; new one does, and the wallet is unchanged
  assert.equal((await api('POST', '/api/auth/login', { email, password })).status, 401);
  const addrAfter = await loginAddress(email, newPassword);
  assert.equal(addrAfter, addrBefore); // same seed → same address
});

async function loginAddress(email, password) {
  const login = await api('POST', '/api/auth/login', { email, password });
  const profile = await api('GET', '/api/wallet/profile', null, login.json.token);
  return profile.json.address;
}

test('no plaintext seed or share is recoverable from the DB at rest without secrets', async () => {
  const email = 'dave@example.com';
  const password = 'davepassword12';
  await api('POST', '/api/auth/register', { email, password });
  await api('POST', '/api/auth/verify', { email, code: '123456' });

  const user = await db.findByEmail(email);
  // The exported seed (what an attacker wants) must not appear in any stored column.
  const login = await api('POST', '/api/auth/login', { email, password });
  const mnemonic = (await api('GET', '/api/wallet/export', null, login.json.token)).json.mnemonic;

  const us = await db.getUserShare(user.id);
  const ts = await db.getTtpShare(user.id);
  const dump = JSON.stringify({ user, us, ts });
  assert.ok(!dump.includes(mnemonic), 'mnemonic must not be present in DB');
  // The user_shares row alone is just one (password-sealed) share — even decrypting it
  // (we cannot, without the password) would be one of three; insufficient to reconstruct.
  assert.ok(us.ciphertext && ts.ciphertext);
});

test('paymail: discovery, pki, and payment destination', async () => {
  // register + verify a second user to look up
  const email = 'bob@example.com';
  await api('POST', '/api/auth/register', { email, password: 'password1234' });
  await api('POST', '/api/auth/verify', { email, code: '123456' });

  const disco = await api('GET', '/.well-known/bsvalias');
  assert.equal(disco.status, 200);
  assert.equal(disco.json.bsvalias, '1.0');
  assert.ok(disco.json.capabilities['0c4339ef99c2b480'].includes('/api/paymail/id/'));

  const pki = await api('GET', '/api/paymail/id/bob@web3keys.com');
  assert.equal(pki.status, 200);
  assert.ok(/^0[23][0-9a-f]{64}$/.test(pki.json.pubkey)); // compressed pubkey hex

  const dest = await api('POST', '/api/paymail/address/bob@web3keys.com', {
    senderHandle: 'x@y.com',
  });
  assert.equal(dest.status, 200);
  assert.ok(/^76a914[0-9a-f]{40}88ac$/.test(dest.json.output)); // standard P2PKH script

  const missing = await api('GET', '/api/paymail/id/nobody@web3keys.com');
  assert.equal(missing.status, 404);
});

test('duplicate registration is rejected', async () => {
  const email = 'dupe@example.com';
  const first = await api('POST', '/api/auth/register', { email, password: 'password1234' });
  assert.equal(first.status, 201);
  const second = await api('POST', '/api/auth/register', { email, password: 'password1234' });
  assert.equal(second.status, 409);
});
