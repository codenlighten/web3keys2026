'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const bsv = require('@smartledger/bsv');

const { threshold, Wallet } = require('../src');

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('splitSeed produces three role-keyed shares', () => {
  const shares = threshold.splitSeed(MNEMONIC);
  assert.ok(shares.user && shares.service && shares.ttp);
  assert.notEqual(shares.user, shares.service);
  assert.ok(threshold.verifyShare(shares.user));
  assert.ok(threshold.verifyShare(shares.service));
  assert.ok(threshold.verifyShare(shares.ttp));
});

test('any two of three shares reconstruct the mnemonic', () => {
  const { user, service, ttp } = threshold.splitSeed(MNEMONIC);
  assert.equal(threshold.reconstruct([service, ttp]), MNEMONIC); // operational (login)
  assert.equal(threshold.reconstruct([user, ttp]), MNEMONIC); // recovery
  assert.equal(threshold.reconstruct([user, service]), MNEMONIC);
  assert.equal(threshold.reconstruct([user, service, ttp]), MNEMONIC); // all three
});

test('a single share alone cannot reconstruct', () => {
  const { user } = threshold.splitSeed(MNEMONIC);
  assert.throws(() => threshold.reconstruct([user]), /at least 2 shares/);
});

test('shares survive a serialize → JSON → deserialize round trip (storage/transport)', () => {
  const shares = threshold.splitSeed(MNEMONIC);
  // emulate persisting each share string through a DB / network as JSON
  const stored = JSON.parse(JSON.stringify(shares));
  assert.equal(threshold.reconstruct([stored.service, stored.ttp]), MNEMONIC);
});

test('reconstructed mnemonic controls the same wallet addresses', () => {
  const original = Wallet.fromMnemonic(MNEMONIC);
  const { service, ttp } = threshold.splitSeed(MNEMONIC);
  const recovered = Wallet.fromMnemonic(threshold.reconstruct([service, ttp]));
  assert.deepEqual(recovered.addresses(), original.addresses());
});

test('random wallets split/reconstruct (fuzz a few)', () => {
  for (let i = 0; i < 5; i++) {
    const m = new bsv.Mnemonic().toString();
    const s = threshold.splitSeed(m);
    assert.equal(threshold.reconstruct([s.user, s.ttp]), m);
  }
});

test('verifyShare rejects garbage', () => {
  assert.ok(!threshold.verifyShare('not-a-share'));
  assert.ok(!threshold.verifyShare(Buffer.from('{}').toString('base64')));
});
