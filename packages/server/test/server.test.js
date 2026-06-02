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
const db = require('../src/db');
const { createApp } = require('../src/app');

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

test('security: mnemonic seal/unseal round trips and rejects wrong password', () => {
  const m =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const sealed = security.encryptMnemonic(m, 'correct horse');
  assert.equal(security.decryptMnemonic(sealed, 'correct horse'), m);
  assert.throws(() => security.decryptMnemonic(sealed, 'wrong password'));
  // password verifier
  const v = security.hashPassword('s3cret!!');
  assert.ok(security.verifyPassword('s3cret!!', v));
  assert.ok(!security.verifyPassword('nope', v));
});

test('full flow: register → verify → login → profile → send-auth-guard', async () => {
  const email = 'alice@example.com';
  const password = 'hunter2hunter2';

  const reg = await api('POST', '/api/auth/register', { email, password });
  assert.equal(reg.status, 201);
  assert.equal(reg.json.mnemonic.split(' ').length, 12); // shown once
  assert.equal(reg.json.profile.paymail, 'alice@web3keys.com');
  const mnemonic = reg.json.mnemonic;

  // cannot log in before verifying
  const early = await api('POST', '/api/auth/login', { email, password });
  assert.equal(early.status, 403);

  const ver = await api('POST', '/api/auth/verify', { email, code: '123456' });
  assert.equal(ver.status, 200);
  assert.ok(ver.json.verified);

  // wrong code path
  const bad = await api('POST', '/api/auth/verify', { email, code: '000000' });
  assert.equal(bad.status, 404); // otp consumed after success

  const login = await api('POST', '/api/auth/login', { email, password });
  assert.equal(login.status, 200);
  assert.ok(login.json.token);
  const token = login.json.token;

  // wrong password rejected
  const wrong = await api('POST', '/api/auth/login', { email, password: 'wrongwrong' });
  assert.equal(wrong.status, 401);

  const profile = await api('GET', '/api/wallet/profile', null, token);
  assert.equal(profile.status, 200);
  assert.equal(profile.json.paymail, 'alice@web3keys.com');
  assert.ok(/^1[1-9A-HJ-NP-Za-km-z]+$/.test(profile.json.address)); // base58 P2PKH

  // the stored deposit address must be reproducible from the mnemonic the user backed up
  const { Wallet } = require('@web3keys/wallet-core');
  const restored = Wallet.fromMnemonic(mnemonic).keyManager.address('finance');
  assert.equal(restored, profile.json.address);

  // protected route without token
  const noauth = await api('GET', '/api/wallet/profile');
  assert.equal(noauth.status, 401);
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
