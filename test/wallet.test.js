'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const bsv = require('@smartledger/bsv');

const { Wallet, KeyDeriver, Ordinals, paths } = require('../src');
const { MockProvider } = require('./helpers/MockProvider');

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function freshWallet() {
  const wallet = Wallet.fromMnemonic(MNEMONIC);
  const provider = new MockProvider();
  wallet.setProvider(provider);
  return { wallet, provider };
}

test('derivation paths match the spec', () => {
  assert.equal(paths.buildPath('identity'), "m/44'/236'/0'/0/0");
  assert.equal(paths.buildPath('finance'), "m/44'/0'/0'/0/0");
  assert.equal(paths.buildPath('tokens'), "m/44'/236'/2'/0/0");
});

test('wallet is deterministic from a mnemonic', () => {
  const a = Wallet.fromMnemonic(MNEMONIC).addresses();
  const b = Wallet.fromMnemonic(MNEMONIC).addresses();
  assert.deepEqual(a, b);
  assert.notEqual(a.identity, a.finance);
  assert.notEqual(a.finance, a.tokens);
});

test('identity message sign/verify', () => {
  const { wallet } = freshWallet();
  const sig = wallet.identity.sign('authenticate me');
  assert.ok(wallet.identity.verify('authenticate me', sig));
  assert.ok(!wallet.identity.verify('different', sig));
});

test('identity ECIES encrypt/decrypt between two wallets', () => {
  const alice = Wallet.generate();
  const bob = Wallet.generate();
  const ct = alice.identity.encryptTo(bob.identity.publicKey, 'hi bob');
  const pt = bob.identity.decryptFrom(alice.identity.publicKey, ct);
  assert.equal(pt, 'hi bob');
});

test('BRC-42 cross-derivation and symmetric agreement', () => {
  const alice = new KeyDeriver(bsv.PrivateKey.fromRandom());
  const bob = new KeyDeriver(bsv.PrivateKey.fromRandom());
  const proto = [2, 'message signing'];
  const bobPubFromAlice = alice.derivePublicKey(proto, '1', bob.identityKey, false);
  const bobPrivFromBob = bob.derivePrivateKey(proto, '1', alice.identityKey);
  assert.equal(bobPubFromAlice.toString(), bobPrivFromBob.publicKey.toString());

  const symA = alice.deriveSymmetricKey(proto, '1', bob.identityKey).toString('hex');
  const symB = bob.deriveSymmetricKey(proto, '1', alice.identityKey).toString('hex');
  assert.equal(symA, symB);
});

test('BRC-100 encrypt/decrypt, hmac, signature round trips', async () => {
  const { wallet } = freshWallet();
  const b = wallet.brc100;
  const proto = [2, 'unit test'];

  const enc = await b.encrypt({ plaintext: 'top secret', protocolID: proto, keyID: '1' });
  const dec = await b.decrypt({ ciphertext: enc.ciphertext, protocolID: proto, keyID: '1' });
  assert.equal(dec.plaintext, 'top secret');

  const h = await b.createHmac({ data: 'payload', protocolID: proto, keyID: '2' });
  assert.ok((await b.verifyHmac({ data: 'payload', hmac: h.hmac, protocolID: proto, keyID: '2' })).valid);
  assert.ok(!(await b.verifyHmac({ data: 'tampered', hmac: h.hmac, protocolID: proto, keyID: '2' })).valid);

  const s = await b.createSignature({ data: 'sign me', protocolID: proto, keyID: '3' });
  assert.ok((await b.verifySignature({ data: 'sign me', signature: s.signature, protocolID: proto, keyID: '3', forSelf: true })).valid);
  assert.ok(!(await b.verifySignature({ data: 'forged', signature: s.signature, protocolID: proto, keyID: '3', forSelf: true })).valid);
});

test('BRC-100 certificate acquire / prove / relinquish', async () => {
  const { wallet } = freshWallet();
  const b = wallet.brc100;
  const cert = (await b.acquireCertificate({ type: 'KYC', certifier: '02abc', fields: { name: 'Greg', age: '30' } })).certificate;
  assert.equal((await b.listCertificates()).totalCertificates, 1);
  const proof = await b.proveCertificate({ certificate: cert, fieldsToReveal: ['name'], verifier: wallet.identity.identityKey });
  assert.ok(proof.keyringForVerifier.name);
  assert.ok(!proof.keyringForVerifier.age);
  await b.relinquishCertificate({ serialNumber: cert.serialNumber });
  assert.equal((await b.listCertificates()).totalCertificates, 0);
});

test('send builds a valid, fully-signed, broadcast transaction', async () => {
  const { wallet, provider } = freshWallet();
  provider.seedUtxo(wallet.keyManager.address('finance'), { satoshis: 100000 });
  const dest = bsv.PrivateKey.fromRandom().toAddress().toString();
  const res = await wallet.send([{ to: dest, satoshis: 25000 }]);
  assert.ok(res.tx.isFullySigned());
  assert.ok(res.tx.verify() === true);
  assert.equal(provider.broadcasts.length, 1);
  assert.ok(res.fee > 0);
});

test('createAction funds, signs and broadcasts via BRC-100', async () => {
  const { wallet, provider } = freshWallet();
  provider.seedUtxo(wallet.keyManager.address('finance'), { satoshis: 50000 });
  const dest = bsv.PrivateKey.fromRandom().toAddress();
  const lockingScript = bsv.Script.buildPublicKeyHashOut(dest).toHex();
  const res = await wallet.brc100.createAction({
    description: 'pay someone',
    outputs: [{ lockingScript, satoshis: 10000, basket: 'payments', outputDescription: 'test pay' }],
    labels: ['test'],
  });
  assert.ok(res.txid);
  assert.ok(res.sent);
  const actions = await wallet.brc100.listActions();
  assert.equal(actions.totalActions, 1);
});

test('deferred createAction pins inputs; signAction ignores later UTXO changes', async () => {
  const { wallet, provider } = freshWallet();
  const financeAddr = wallet.keyManager.address('finance');
  provider.seedUtxo(financeAddr, { satoshis: 30000 });
  provider.seedUtxo(financeAddr, { satoshis: 30000 });

  const dest = bsv.Script.buildPublicKeyHashOut(bsv.PrivateKey.fromRandom().toAddress()).toHex();
  const created = await wallet.brc100.createAction({
    description: 'deferred pay',
    outputs: [{ lockingScript: dest, satoshis: 10000 }],
    options: { signAndProcess: false },
  });

  assert.ok(created.reference);
  const pinned = created.signableTransaction.inputs;
  assert.ok(pinned.length >= 1);
  const pinnedOutpoints = pinned.map((i) => `${i.txid}:${i.vout}`).sort();
  // the returned unsigned tx should reference exactly the pinned inputs
  const unsignedTx = new bsv.Transaction(created.signableTransaction.tx);
  const unsignedOutpoints = unsignedTx.inputs
    .map((i) => `${i.prevTxId.toString('hex')}:${i.outputIndex}`)
    .sort();
  assert.deepEqual(unsignedOutpoints, pinnedOutpoints);

  // The funding picture changes completely after create: drop old UTXOs, add new ones.
  provider._utxos.set(financeAddr, []);
  provider.seedUtxo(financeAddr, { satoshis: 999999 });

  const signed = await wallet.brc100.signAction({ reference: created.reference });
  const signedTx = new bsv.Transaction(signed.tx);
  const signedOutpoints = signedTx.inputs
    .map((i) => `${i.prevTxId.toString('hex')}:${i.outputIndex}`)
    .sort();

  assert.deepEqual(signedOutpoints, pinnedOutpoints, 'signAction must use the pinned inputs');
  // Every input carries an unlocking script (finalize() already guaranteed full signing
  // before serialization; a re-parsed tx loses prevout info so we can't re-run verify()).
  assert.ok(signedTx.inputs.every((i) => i.script.toBuffer().length > 0));
  assert.ok(signed.sent);
});

test('pending actions persist through storage across wallet instances', async () => {
  const { MemoryStorage } = require('../src');
  const storage = new MemoryStorage();
  const provider = new MockProvider();
  provider.seedUtxo(Wallet.fromMnemonic(MNEMONIC).keyManager.address('finance'), { satoshis: 30000 });

  // Instance A creates the deferred action (e.g. an online, watch-only-ish device).
  const walletA = Wallet.fromMnemonic(MNEMONIC, { storage, provider });
  const dest = bsv.Script.buildPublicKeyHashOut(bsv.PrivateKey.fromRandom().toAddress()).toHex();
  const created = await walletA.brc100.createAction({
    description: 'cross-instance',
    outputs: [{ lockingScript: dest, satoshis: 8000 }],
    options: { signAndProcess: false },
  });

  // The pending action lives in storage, not in walletA's memory.
  assert.equal((await storage.listPendingActions()).length, 1);

  // Instance B (simulating a process restart / separate signer) shares the SAME storage
  // and the same seed. It has never seen `created`, yet can sign it from storage alone.
  const walletB = Wallet.fromMnemonic(MNEMONIC, { storage });
  assert.equal((await walletB.brc100.listPendingActions()).totalPendingActions, 1);

  const signed = await walletB.brc100.signAction({
    reference: created.reference,
    options: { noSend: true }, // walletB has no provider
  });
  const tx = new bsv.Transaction(signed.tx);
  assert.ok(tx.inputs.every((i) => i.script.toBuffer().length > 0));
  // outpoints match what instance A pinned
  const pinned = created.signableTransaction.inputs.map((i) => `${i.txid}:${i.vout}`).sort();
  const got = tx.inputs.map((i) => `${i.prevTxId.toString('hex')}:${i.outputIndex}`).sort();
  assert.deepEqual(got, pinned);
  // consumed from storage after signing
  assert.equal((await storage.listPendingActions()).length, 0);
});

test('pending action record contains no private key material', async () => {
  const { wallet, provider } = freshWallet();
  provider.seedUtxo(wallet.keyManager.address('finance'), { satoshis: 20000 });
  const dest = bsv.Script.buildPublicKeyHashOut(bsv.PrivateKey.fromRandom().toAddress()).toHex();
  const created = await wallet.brc100.createAction({
    outputs: [{ lockingScript: dest, satoshis: 1000 }],
    options: { signAndProcess: false },
  });
  const rec = await wallet.brc100.storage.getPendingAction(created.reference);
  const serialized = JSON.stringify(rec);
  assert.ok(!('fundingKey' in rec));
  assert.equal(rec.fundingAccount, 'finance');
  // a WIF/hex private key would survive JSON; assert the funding key is absent from it
  const wif = wallet.keyManager.privateKey('finance').toString();
  assert.ok(!serialized.includes(wif));
});

test('signAction accepts an override signing key (multi-party/offline)', async () => {
  const { wallet, provider } = freshWallet();
  const financeAddr = wallet.keyManager.address('finance');
  provider.seedUtxo(financeAddr, { satoshis: 40000 });

  const dest = bsv.Script.buildPublicKeyHashOut(bsv.PrivateKey.fromRandom().toAddress()).toHex();
  const created = await wallet.brc100.createAction({
    outputs: [{ lockingScript: dest, satoshis: 5000 }],
    options: { signAndProcess: false },
  });

  // Sign with the correct finance key passed explicitly (simulating an external signer).
  const fundingKey = wallet.keyManager.privateKey('finance');
  const signed = await wallet.brc100.signAction({
    reference: created.reference,
    privateKeys: [fundingKey],
    options: { noSend: true },
  });
  const tx = new bsv.Transaction(signed.tx);
  assert.ok(tx.inputs.every((i) => i.script.toBuffer().length > 0));
  assert.equal(signed.sent, false);
});

test('abortAction discards a pending pinned action', async () => {
  const { wallet, provider } = freshWallet();
  provider.seedUtxo(wallet.keyManager.address('finance'), { satoshis: 20000 });
  const dest = bsv.Script.buildPublicKeyHashOut(bsv.PrivateKey.fromRandom().toAddress()).toHex();
  const created = await wallet.brc100.createAction({
    outputs: [{ lockingScript: dest, satoshis: 1000 }],
    options: { signAndProcess: false },
  });
  assert.ok((await wallet.brc100.abortAction({ reference: created.reference })).aborted);
  await assert.rejects(() => wallet.brc100.signAction({ reference: created.reference }));
});

test('inscribe builds a valid 1Sat ordinal and it parses back', async () => {
  const { wallet, provider } = freshWallet();
  provider.seedUtxo(wallet.keyManager.address('finance'), { satoshis: 100000 });
  const res = await wallet.inscribe({ data: 'hello ordinal', contentType: 'text/plain' });
  assert.ok(res.tx.isFullySigned());
  assert.ok(res.tx.verify() === true);
  const ordOut = res.tx.outputs[res.ordinalVout];
  assert.equal(ordOut.satoshis, 1);
  const parsed = Ordinals.parseInscription(ordOut.script);
  assert.equal(parsed.contentType, 'text/plain');
  assert.equal(parsed.data.toString('utf8'), 'hello ordinal');
});

test('transferOrdinal spends the ordinal as first input', async () => {
  const { wallet, provider } = freshWallet();
  const tokensAddr = wallet.keyManager.address('tokens');
  const financeAddr = wallet.keyManager.address('finance');
  const ordinalUtxo = provider.seedUtxo(tokensAddr, { satoshis: 1 });
  provider.seedUtxo(financeAddr, { satoshis: 50000 });
  const dest = bsv.PrivateKey.fromRandom().toAddress().toString();
  const res = await wallet.transferOrdinal({ ordinalUtxo, toAddress: dest });
  assert.ok(res.tx.isFullySigned());
  assert.ok(res.tx.verify() === true);
  // ordinal (1 sat) is the smallest input, so coin selection places it first
  assert.equal(res.tx.inputs[0].output.satoshis, 1);
  assert.equal(res.tx.outputs[0].satoshis, 1);
});
