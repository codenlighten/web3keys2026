'use strict';

const bsv = require('@smartledger/bsv');
const { Mnemonic, HDPrivateKey, Networks } = bsv;
const { ACCOUNTS, buildPath, accountPath } = require('./paths');

/**
 * KeyManager owns the BIP-39 seed and derives keys for the wallet's accounts.
 * It is deterministic and offline — no network access lives here.
 */
class KeyManager {
  /**
   * @param {object} opts
   * @param {string} [opts.mnemonic]  BIP-39 phrase. Generated if omitted.
   * @param {string} [opts.passphrase] optional BIP-39 passphrase
   * @param {'livenet'|'testnet'} [opts.network]
   */
  constructor({ mnemonic, passphrase = '', network = 'livenet', strength = 256 } = {}) {
    this.network = Networks[network] || Networks.livenet;
    this.passphrase = passphrase;

    if (mnemonic) {
      if (!Mnemonic.isValid(mnemonic)) {
        throw new Error('Invalid BIP-39 mnemonic');
      }
      this._mnemonic = Mnemonic.fromString(mnemonic);
    } else {
      // Default to 256-bit entropy → 24-word recovery phrase.
      this._mnemonic = new Mnemonic(strength);
    }

    const seed = this._mnemonic.toSeed(this.passphrase);
    this.master = HDPrivateKey.fromSeed(seed, this.network);
    this._cache = new Map();
  }

  static generate(opts = {}) {
    return new KeyManager(opts);
  }

  static fromMnemonic(mnemonic, opts = {}) {
    return new KeyManager({ ...opts, mnemonic });
  }

  get mnemonic() {
    return this._mnemonic.toString();
  }

  /** Master fingerprint (hex) — useful for identifying a seed without exposing it. */
  get fingerprint() {
    return this.master.hdPublicKey.fingerprint.toString('hex');
  }

  /** Derive the HDPrivateKey at the account root, e.g. m/44'/236'/0'. */
  accountKey(account) {
    const path = accountPath(account);
    return this._derive(path);
  }

  /** Derive a full leaf HDPrivateKey for an account at change/index. */
  deriveKey(account, opts = {}) {
    const path = buildPath(account, opts);
    return this._derive(path);
  }

  /** Convenience: the leaf PrivateKey for an account address. */
  privateKey(account, opts = {}) {
    return this.deriveKey(account, opts).privateKey;
  }

  /** Convenience: the PublicKey for an account address. */
  publicKey(account, opts = {}) {
    return this.deriveKey(account, opts).privateKey.publicKey;
  }

  /** Convenience: the Address string for an account address. */
  address(account, opts = {}) {
    return this.privateKey(account, opts).toAddress(this.network).toString();
  }

  /** Derive a key at an arbitrary absolute path string. */
  derivePath(path) {
    return this._derive(path);
  }

  _derive(path) {
    if (this._cache.has(path)) return this._cache.get(path);
    const key = this.master.deriveChild(path);
    this._cache.set(path, key);
    return key;
  }

  /** Summary of the three account roots (xpub-level, safe to share). */
  describe() {
    const out = {};
    for (const name of Object.keys(ACCOUNTS)) {
      const acct = ACCOUNTS[name];
      const root = this.accountKey(name);
      out[name] = {
        ...acct,
        path: accountPath(name),
        xpub: root.hdPublicKey.toString(),
        firstAddress: this.address(name),
      };
    }
    return out;
  }
}

module.exports = { KeyManager };
