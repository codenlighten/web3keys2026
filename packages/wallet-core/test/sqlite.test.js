'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const bsv = require('@smartledger/bsv');

const { Wallet, SqliteStorage } = require('../src');
const { MockProvider } = require('./helpers/MockProvider');

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function tmpDbPath() {
  const rand = bsv.crypto.Random.getRandomBuffer(8).toString('hex');
  return path.join(os.tmpdir(), `web3keys2-test-${rand}.db`);
}

test('SqliteStorage implements the full WalletStorage surface', async () => {
  const storage = new SqliteStorage(':memory:');

  // outputs / baskets
  await storage.insertOutput({
    basket: 'ord',
    txid: 'aa',
    vout: 0,
    satoshis: 1,
    lockingScript: '00',
    tags: ['x'],
  });
  await storage.insertOutput({
    basket: 'pay',
    txid: 'bb',
    vout: 1,
    satoshis: 100,
    lockingScript: '01',
  });
  assert.equal((await storage.listOutputs({ basket: 'ord' })).length, 1);
  assert.equal((await storage.listOutputs({ tags: ['x'] })).length, 1);
  assert.equal((await storage.listOutputs({ tags: ['nope'] })).length, 0);
  await storage.markSpent('aa', 0);
  assert.equal((await storage.listOutputs({ basket: 'ord' })).length, 0);
  assert.equal((await storage.listOutputs({ basket: 'ord', includeSpent: true })).length, 1);
  await storage.removeOutput('bb', 1);
  // 'aa' is spent (excluded by default), 'bb' was removed → nothing spendable remains.
  assert.equal((await storage.listOutputs({})).length, 0);
  assert.equal((await storage.listOutputs({ includeSpent: true })).length, 1);

  // certificates
  await storage.insertCertificate({
    serialNumber: 's1',
    type: 'KYC',
    certifier: 'c1',
    fields: { name: 'g' },
  });
  await storage.insertCertificate({ serialNumber: 's2', type: 'AGE', certifier: 'c2', fields: {} });
  assert.equal((await storage.listCertificates({ types: ['KYC'] })).length, 1);
  assert.equal((await storage.listCertificates({ certifiers: ['c2'] }))[0].type, 'AGE');
  assert.ok(await storage.removeCertificate({ serialNumber: 's1' }));
  assert.equal((await storage.listCertificates()).length, 1);

  // actions
  await storage.insertAction({
    txid: 't1',
    description: 'd',
    status: 'unproven',
    labels: ['l1'],
    fee: 5,
  });
  const updated = await storage.updateAction('t1', { status: 'completed' });
  assert.equal(updated.status, 'completed');
  assert.equal(updated.description, 'd'); // merge preserved other fields
  assert.equal((await storage.listActions({ status: 'completed' })).length, 1);
  assert.equal((await storage.listActions({ labels: ['l1'] })).length, 1);
  assert.equal((await storage.listActions({ labels: ['nope'] })).length, 0);

  storage.close();
});

test('pending action survives a simulated process restart (file-backed sqlite)', async () => {
  const dbPath = tmpDbPath();
  try {
    const provider = new MockProvider();
    provider.seedUtxo(Wallet.fromMnemonic(MNEMONIC).keyManager.address('finance'), {
      satoshis: 30000,
    });

    // Process 1: open the db, create a deferred action, then close (process exits).
    let reference, pinned;
    {
      const storage = new SqliteStorage(dbPath);
      const walletA = Wallet.fromMnemonic(MNEMONIC, { storage, provider });
      const dest = bsv.Script.buildPublicKeyHashOut(
        bsv.PrivateKey.fromRandom().toAddress()
      ).toHex();
      const created = await walletA.brc100.createAction({
        description: 'survive restart',
        outputs: [{ lockingScript: dest, satoshis: 9000 }],
        options: { signAndProcess: false },
      });
      reference = created.reference;
      pinned = created.signableTransaction.inputs.map((i) => `${i.txid}:${i.vout}`).sort();
      storage.close();
    }

    // Process 2: reopen the SAME db file fresh, same seed, no provider. Sign from disk.
    {
      const storage = new SqliteStorage(dbPath);
      const walletB = Wallet.fromMnemonic(MNEMONIC, { storage });
      assert.equal((await walletB.brc100.listPendingActions()).totalPendingActions, 1);

      const signed = await walletB.brc100.signAction({ reference, options: { noSend: true } });
      const tx = new bsv.Transaction(signed.tx);
      assert.ok(tx.inputs.every((i) => i.script.toBuffer().length > 0));
      const got = tx.inputs.map((i) => `${i.prevTxId.toString('hex')}:${i.outputIndex}`).sort();
      assert.deepEqual(got, pinned);
      assert.equal((await walletB.brc100.listPendingActions()).totalPendingActions, 0);
      storage.close();
    }
  } finally {
    for (const ext of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + ext);
      } catch {
        /* ignore */
      }
    }
  }
});

test('no private key is written to the sqlite pending_actions table', async () => {
  const dbPath = tmpDbPath();
  try {
    const provider = new MockProvider();
    const storage = new SqliteStorage(dbPath);
    const wallet = Wallet.fromMnemonic(MNEMONIC, { storage, provider });
    provider.seedUtxo(wallet.keyManager.address('finance'), { satoshis: 20000 });
    const dest = bsv.Script.buildPublicKeyHashOut(bsv.PrivateKey.fromRandom().toAddress()).toHex();
    await wallet.brc100.createAction({
      outputs: [{ lockingScript: dest, satoshis: 1000 }],
      options: { signAndProcess: false },
    });
    storage.close();

    // Inspect the raw file bytes: the finance WIF must not appear anywhere.
    const wif = wallet.keyManager.privateKey('finance').toString();
    const raw = fs.readFileSync(dbPath);
    assert.ok(!raw.includes(Buffer.from(wif)), 'private key leaked into sqlite file');
  } finally {
    for (const ext of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + ext);
      } catch {
        /* ignore */
      }
    }
  }
});
