'use strict';

const bsv = require('@smartledger/bsv');
const { Script, Address, Transaction, crypto } = bsv;
const { ChainProvider } = require('../../src/providers/ChainProvider');

/** Realistic, distinct txid (mixed bytes) from a label — avoids UTF-8 collision quirks. */
function fakeTxid(label) {
  return crypto.Hash.sha256(Buffer.from(String(label), 'utf8')).toString('hex');
}

/**
 * In-memory chain provider for tests. Lets you seed UTXOs per address and captures
 * broadcasts. Reconstructs P2PKH scripts so the tx builder can sign.
 */
class MockProvider extends ChainProvider {
  constructor({ network = 'livenet' } = {}) {
    super();
    this._network = network;
    this._utxos = new Map(); // address -> [utxo]
    this.broadcasts = [];
    this.height = 800000;
    this._seq = 0;
  }

  get network() {
    return this._network;
  }

  seedUtxo(address, { satoshis, txid, vout = 0, script } = {}) {
    const list = this._utxos.get(address) || [];
    const lockingScript = script || Script.buildPublicKeyHashOut(new Address(address)).toHex();
    const utxo = {
      txid: txid || fakeTxid(`utxo-${this._seq++}`),
      vout,
      satoshis,
      script: lockingScript,
    };
    list.push(utxo);
    this._utxos.set(address, list);
    return utxo;
  }

  async getBalance(address) {
    const list = this._utxos.get(address) || [];
    return { confirmed: list.reduce((s, u) => s + u.satoshis, 0), unconfirmed: 0 };
  }

  async getUtxos(address) {
    return [...(this._utxos.get(address) || [])];
  }

  async getRawTx() {
    throw new Error('MockProvider.getRawTx not seeded');
  }

  async broadcast(rawTxHex) {
    const tx = new Transaction(rawTxHex);
    this.broadcasts.push(rawTxHex);
    return tx.hash;
  }

  async getHeight() {
    return this.height;
  }

  async getHeaderForHeight() {
    return '00'.repeat(80);
  }
}

module.exports = { MockProvider };
