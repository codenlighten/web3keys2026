'use strict';

const bsv = require('@smartledger/bsv');
const { KeyManager } = require('./KeyManager');
const { Identity } = require('./identity/Identity');
const { BRC100Wallet } = require('./brc100/BRC100Wallet');
const { buildPayment } = require('./tx/TxBuilder');
const Ordinals = require('./ordinals/Ordinals');

/**
 * Wallet is the top-level orchestrator that ties the pieces together:
 *   - KeyManager   : HD keys for identity / finance / tokens accounts
 *   - Identity     : signing, verification, encrypted messaging, DID
 *   - BRC100Wallet : full BRC-100 substrate (createAction, certificates, ...)
 *   - Ordinals     : 1Sat inscriptions + transfers
 *   - provider     : pluggable chain data source
 *
 * Higher-level convenience methods (getBalance, send, inscribe, transferOrdinal)
 * use the `finance` account for funds and the `tokens` account for ordinals.
 */
class Wallet {
  constructor({
    mnemonic,
    passphrase,
    network = 'livenet',
    provider,
    storage,
    feePerKb = 50,
  } = {}) {
    this.keyManager = new KeyManager({ mnemonic, passphrase, network });
    this.provider = provider || null;
    this.feePerKb = feePerKb;

    this.identity = new Identity(this.keyManager);
    this.brc100 = new BRC100Wallet({ keyManager: this.keyManager, provider, storage, feePerKb });
  }

  static generate(opts = {}) {
    return new Wallet(opts);
  }

  static fromMnemonic(mnemonic, opts = {}) {
    return new Wallet({ ...opts, mnemonic });
  }

  get mnemonic() {
    return this.keyManager.mnemonic;
  }

  setProvider(provider) {
    this.provider = provider;
    this.brc100.provider = provider;
    return this;
  }

  /** Account addresses overview. */
  addresses() {
    return {
      identity: this.keyManager.address('identity'),
      finance: this.keyManager.address('finance'),
      tokens: this.keyManager.address('tokens'),
    };
  }

  describe() {
    return {
      mnemonic: this.mnemonic,
      identityKey: this.identity.identityKey,
      ...this.keyManager.describe(),
    };
  }

  // ───────────────────────── balances / funds ─────────────────────────

  async getBalance(account = 'finance') {
    this._requireProvider();
    return this.provider.getBalance(this.keyManager.address(account));
  }

  /**
   * Send BSV from the finance account.
   * @param {Array} outputs [{ to, satoshis }]
   * @param {object} [opts] { broadcast=true, feePerKb }
   */
  async send(outputs, opts = {}) {
    this._requireProvider();
    const fundingAddress = this.keyManager.address('finance');
    const fundingKey = this.keyManager.privateKey('finance');
    const utxos = await this.provider.getUtxos(fundingAddress);

    const built = buildPayment({
      utxos,
      ownerAddress: fundingAddress,
      outputs,
      changeAddress: fundingAddress,
      privateKeys: fundingKey,
      feePerKb: opts.feePerKb || this.feePerKb,
    });

    if (opts.broadcast !== false) {
      built.broadcastTxid = await this.provider.broadcast(built.rawHex);
    }
    return built;
  }

  // ───────────────────────── HD multi-address (gap-limit scan) ─────────────────────────

  /**
   * Scan derived addresses of an account for UTXOs until `gapLimit` consecutive empty
   * addresses are seen (BIP-44 gap limit). Each returned UTXO carries its owning address,
   * private key, and a reconstructed P2PKH script (so providers that omit scripts work).
   */
  async scanUtxos(account = 'finance', { gapLimit = 20, change = 0, maxIndex = 5000 } = {}) {
    this._requireProvider();
    const net = this.keyManager.network;
    const found = [];
    let consecutiveEmpty = 0;
    for (let index = 0; index <= maxIndex && consecutiveEmpty < gapLimit; index++) {
      const priv = this.keyManager.privateKey(account, { change, index });
      const address = priv.toAddress(net).toString();
      // eslint-disable-next-line no-await-in-loop
      const utxos = await this.provider.getUtxos(address);
      if (!utxos.length) {
        consecutiveEmpty += 1;
        continue;
      }
      consecutiveEmpty = 0;
      const script = bsv.Script.buildPublicKeyHashOut(priv.toAddress(net)).toHex();
      for (const u of utxos) {
        found.push({ ...u, script: u.script || script, address, privateKey: priv, index });
      }
    }
    return found;
  }

  /** Total spendable balance across an account's scanned addresses (satoshis). */
  async accountBalance(account = 'finance', opts = {}) {
    const utxos = await this.scanUtxos(account, opts);
    return utxos.reduce((s, u) => s + u.satoshis, 0);
  }

  /**
   * Send BSV gathering UTXOs across ALL funded addresses of an account (not just index 0),
   * signing each input with its own key. Change returns to `changeAddress` (default: the
   * account's index-0 address).
   */
  async sendFromAccount(outputs, opts = {}) {
    this._requireProvider();
    const account = opts.account || 'finance';
    const scanned = await this.scanUtxos(account, { gapLimit: opts.gapLimit || 20 });
    if (!scanned.length) throw new Error(`No spendable UTXOs in the ${account} account`);

    // Distinct signing keys for the funded addresses (bsv matches each key to its inputs).
    const keys = [...new Map(scanned.map((u) => [u.address, u.privateKey])).values()];
    const utxos = scanned.map(({ privateKey, address, index, ...u }) => u); // provider shape w/ script

    const built = buildPayment({
      utxos,
      outputs,
      changeAddress: opts.changeAddress || this.keyManager.address(account),
      privateKeys: keys,
      feePerKb: opts.feePerKb || this.feePerKb,
    });

    if (opts.broadcast !== false) {
      built.broadcastTxid = await this.provider.broadcast(built.rawHex);
    }
    return built;
  }

  // ───────────────────────── ordinals ─────────────────────────

  /** Inscribe a 1Sat Ordinal, owned by the tokens account, funded by finance. */
  async inscribe({ data, contentType = 'text/plain', ownerAddress, broadcast = true } = {}) {
    this._requireProvider();
    const fundingAddress = this.keyManager.address('finance');
    const fundingKey = this.keyManager.privateKey('finance');
    const owner = ownerAddress || this.keyManager.address('tokens');
    const utxos = await this.provider.getUtxos(fundingAddress);

    const result = Ordinals.inscribe({
      fundingUtxos: utxos,
      fundingAddress,
      ownerAddress: owner,
      data,
      contentType,
      changeAddress: fundingAddress,
      privateKeys: fundingKey,
      feePerKb: this.feePerKb,
    });

    if (broadcast) {
      result.broadcastTxid = await this.provider.broadcast(result.rawHex);
    }
    return result;
  }

  /** Transfer an existing ordinal (owned by tokens account) to a new address. */
  async transferOrdinal({ ordinalUtxo, toAddress, broadcast = true } = {}) {
    this._requireProvider();
    const ordinalOwnerAddress = this.keyManager.address('tokens');
    const ordinalKey = this.keyManager.privateKey('tokens');
    const fundingAddress = this.keyManager.address('finance');
    const fundingKey = this.keyManager.privateKey('finance');
    const fundingUtxos = await this.provider.getUtxos(fundingAddress);

    const result = Ordinals.transfer({
      ordinalUtxo,
      ordinalOwnerAddress,
      toAddress,
      fundingUtxos,
      fundingAddress,
      changeAddress: fundingAddress,
      privateKeys: [ordinalKey, fundingKey],
      feePerKb: this.feePerKb,
    });

    if (broadcast) {
      result.broadcastTxid = await this.provider.broadcast(result.rawHex);
    }
    return result;
  }

  async listOrdinals() {
    this._requireProvider();
    const addr = this.keyManager.address('tokens');
    return this.provider.getOrdinalUtxos(addr);
  }

  _requireProvider() {
    if (!this.provider) throw new Error('No chain provider configured (wallet.setProvider(...))');
  }
}

module.exports = { Wallet };
