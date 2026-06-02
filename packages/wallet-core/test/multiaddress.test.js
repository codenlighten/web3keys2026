'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const bsv = require('@smartledger/bsv');
const { Wallet } = require('../src');
const { MockProvider } = require('./helpers/MockProvider');

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function fund() {
  const wallet = Wallet.fromMnemonic(MNEMONIC);
  const provider = new MockProvider();
  wallet.setProvider(provider);
  // Seed funds across THREE different finance addresses (indices 0,1,2).
  const a0 = wallet.keyManager.address('finance', { index: 0 });
  const a1 = wallet.keyManager.address('finance', { index: 1 });
  const a2 = wallet.keyManager.address('finance', { index: 2 });
  provider.seedUtxo(a0, { satoshis: 10000 });
  provider.seedUtxo(a1, { satoshis: 20000 });
  provider.seedUtxo(a2, { satoshis: 5000 });
  return { wallet, provider, addrs: [a0, a1, a2] };
}

test('scanUtxos finds UTXOs across multiple derived addresses (gap limit)', async () => {
  const { wallet, addrs } = fund();
  const utxos = await wallet.scanUtxos('finance', { gapLimit: 20 });
  assert.equal(utxos.length, 3);
  assert.deepEqual(utxos.map((u) => u.address).sort(), [...addrs].sort());
  assert.ok(utxos.every((u) => u.script && u.privateKey));
});

test('accountBalance sums across all funded addresses', async () => {
  const { wallet } = fund();
  assert.equal(await wallet.accountBalance('finance'), 35000);
});

test('sendFromAccount spends inputs from multiple addresses and signs each', async () => {
  const { wallet, provider } = fund();
  const dest = bsv.PrivateKey.fromRandom().toAddress().toString();
  const res = await wallet.sendFromAccount([{ to: dest, satoshis: 28000 }]);

  assert.ok(res.tx.isFullySigned());
  assert.equal(res.tx.verify(), true);
  assert.ok(res.tx.inputs.length >= 2, 'should draw from more than one address');
  assert.equal(provider.broadcasts.length, 1);
  // every input carries an unlocking script (all signed)
  assert.ok(res.tx.inputs.every((i) => i.script.toBuffer().length > 0));
});

test('scanUtxos stops after the gap limit (no infinite scan)', async () => {
  const wallet = Wallet.fromMnemonic(MNEMONIC);
  const provider = new MockProvider();
  wallet.setProvider(provider);
  // Fund only index 0; with gapLimit 5 the scan visits ~6 addresses then stops.
  provider.seedUtxo(wallet.keyManager.address('finance', { index: 0 }), { satoshis: 1000 });
  const utxos = await wallet.scanUtxos('finance', { gapLimit: 5 });
  assert.equal(utxos.length, 1);
});
