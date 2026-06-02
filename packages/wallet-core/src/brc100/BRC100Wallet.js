'use strict';

const bsv = require('@smartledger/bsv');
const { Transaction, crypto } = bsv;
const { KeyDeriver } = require('./KeyDeriver');
const { CryptoOps } = require('./cryptoOps');
const { MemoryStorage } = require('./storage');
const {
  buildPayment,
  buildFromInputs,
  selectInputs,
  assembleUnsigned,
} = require('../tx/TxBuilder');

const VERSION = 'web3keys2-brc100-0.1.0';

/**
 * BRC100Wallet implements the BRC-100 wallet-to-application interface on top of
 * @smartledger/bsv, the BRC-42/43 KeyDeriver, a pluggable ChainProvider and a
 * WalletStorage. Method names and shapes follow the BRC-100 / @bsv/sdk
 * WalletInterface so application code written against that standard can drive it.
 *
 * Funding/identity wiring:
 *   - identity key  = KeyManager leaf for the `identity` account (BRC-42 root)
 *   - funding keys  = KeyManager `finance` account (pays fees, receives change)
 */
class BRC100Wallet {
  /**
   * @param {object} ctx
   * @param {import('../KeyManager').KeyManager} ctx.keyManager
   * @param {import('../providers/ChainProvider').ChainProvider} [ctx.provider]
   * @param {object} [ctx.storage]
   * @param {number} [ctx.feePerKb]
   */
  constructor({ keyManager, provider, storage, feePerKb = 50 } = {}) {
    if (!keyManager) throw new Error('BRC100Wallet requires a keyManager');
    this.keyManager = keyManager;
    this.provider = provider || null;
    this.storage = storage || new MemoryStorage();
    this.feePerKb = feePerKb;

    this.identityPrivateKey = keyManager.privateKey('identity');
    this.keyDeriver = new KeyDeriver(this.identityPrivateKey);
    this.cryptoOps = new CryptoOps(this.keyDeriver);

    this._authenticated = true; // local wallet: holder is authenticated by key custody
    // Pending (deferred) actions are persisted through this.storage so a create→sign
    // session can span process restarts when a durable WalletStorage is supplied.
  }

  // ────────────────────────────── identity / info ──────────────────────────────

  async isAuthenticated() {
    return { authenticated: this._authenticated };
  }

  async waitForAuthentication() {
    return { authenticated: true };
  }

  async getNetwork() {
    const net = this.provider ? this.provider.network : this.keyManager.network.name;
    return { network: net === 'testnet' ? 'testnet' : 'mainnet' };
  }

  async getVersion() {
    return { version: VERSION };
  }

  async getHeight() {
    if (!this.provider) throw new Error('No provider configured');
    return { height: await this.provider.getHeight() };
  }

  async getHeaderForHeight(args) {
    if (!this.provider) throw new Error('No provider configured');
    const height = typeof args === 'number' ? args : args.height;
    return { header: await this.provider.getHeaderForHeight(height) };
  }

  // ────────────────────────────── public keys ──────────────────────────────

  /**
   * @param {object} a
   * @param {boolean} [a.identityKey] true → return the wallet's root identity public key
   * @param {[number,string]|string} [a.protocolID]
   * @param {string} [a.keyID]
   * @param {string|'self'|'anyone'} [a.counterparty]
   * @param {boolean} [a.forSelf]
   */
  async getPublicKey(a = {}) {
    if (a.identityKey) {
      return { publicKey: this.keyDeriver.identityKey.toString() };
    }
    if (!a.protocolID || a.keyID === undefined) {
      throw new Error('getPublicKey requires identityKey:true or {protocolID, keyID}');
    }
    const pub = this.keyDeriver.derivePublicKey(
      a.protocolID,
      a.keyID,
      a.counterparty || 'self',
      a.forSelf || false
    );
    return { publicKey: pub.toString() };
  }

  /**
   * BRC-72 specific key linkage: reveal the derivation linkage for one (protocol,keyID)
   * to a verifier, encrypted so only that verifier can read it. Returns the encrypted
   * linkage payload plus the prover/counterparty identity keys.
   */
  async revealSpecificKeyLinkage(a = {}) {
    const { protocolID, keyID, counterparty, verifier } = a;
    const invoice = require('./KeyDeriver').computeInvoiceNumber(protocolID, keyID);
    // The linkage is the shared-secret-derived scalar; encrypt it for the verifier.
    const linkage = this.cryptoOps.kd.deriveSymmetricKey(protocolID, keyID, counterparty);
    const encryptedLinkage = this.cryptoOps.encrypt({
      plaintext: linkage,
      protocolID: [2, 'specific linkage revelation'],
      keyID: invoice,
      counterparty: verifier,
    });
    return {
      prover: this.keyDeriver.identityKey.toString(),
      verifier: String(verifier),
      counterparty: String(counterparty),
      protocolID,
      keyID,
      encryptedLinkage: encryptedLinkage.toString('hex'),
      proofType: 'specific',
    };
  }

  // ────────────────────────────── crypto ops ──────────────────────────────

  async encrypt(a) {
    const ciphertext = this.cryptoOps.encrypt(a);
    return { ciphertext: ciphertext.toString('hex') };
  }

  async decrypt(a) {
    const plaintext = this.cryptoOps.decrypt(a);
    return { plaintext: plaintext.toString('utf8'), plaintextBytes: plaintext };
  }

  async createHmac(a) {
    return { hmac: this.cryptoOps.createHmac(a).toString('hex') };
  }

  async verifyHmac(a) {
    return { valid: this.cryptoOps.verifyHmac(a) };
  }

  async createSignature(a) {
    return { signature: this.cryptoOps.createSignature(a).toString('hex') };
  }

  async verifySignature(a) {
    return { valid: this.cryptoOps.verifySignature(a) };
  }

  // ────────────────────────────── actions (transactions) ──────────────────────────────

  // Random, collision-free reference — no counter state to persist across restarts.
  _nextRef() {
    return `ref_${crypto.Random.getRandomBuffer(12).toString('hex')}`;
  }

  /**
   * Create (and optionally sign + broadcast) a transaction.
   * @param {object} a
   * @param {string} a.description
   * @param {Array}  a.outputs  [{ lockingScript(hex), satoshis, basket, tags, outputDescription }]
   * @param {string[]} [a.labels]
   * @param {object} [a.options] { signAndProcess=true, acceptDelayedBroadcast=false, noSend=false }
   */
  async createAction(a = {}) {
    const { description = '', outputs = [], labels = [], options = {} } = a;
    const signAndProcess = options.signAndProcess !== false;

    if (!this.provider) throw new Error('createAction requires a provider for funding');

    const fundingAccount = 'finance';
    const fundingAddress = this.keyManager.address(fundingAccount);
    const changeAddress = fundingAddress;
    const fundingKey = this.keyManager.privateKey(fundingAccount);
    const utxos = await this.provider.getUtxos(fundingAddress);

    const txOutputs = outputs.map((o) => ({ script: o.lockingScript, satoshis: o.satoshis }));

    if (!signAndProcess) {
      // Deferred flow: select and PIN the exact inputs now, so signAction rebuilds
      // the identical transaction with no re-fetch and no re-selection. This keeps
      // create-time and sign-time deterministic for offline/multi-party signing.
      const reference = this._nextRef();
      const { inputs } = selectInputs({
        utxos,
        ownerAddress: fundingAddress,
        outputs: txOutputs,
        feePerKb: this.feePerKb,
      });

      // Build the unsigned transaction so the caller can inspect/relay it verbatim.
      const unsigned = assembleUnsigned({
        inputs,
        ownerAddress: fundingAddress,
        outputs: txOutputs,
        changeAddress,
        feePerKb: this.feePerKb,
      });

      // Persist a JSON-serializable record (no private keys) so the pending action
      // survives a process restart when backed by a durable WalletStorage.
      await this.storage.insertPendingAction(reference, {
        outputs,
        txOutputs,
        pinnedInputs: inputs, // <- the pinned, self-contained input set
        fundingAccount, // signAction re-derives the signing key from this account
        fundingAddress,
        changeAddress,
        labels,
        description,
        feePerKb: this.feePerKb,
        options,
      });

      return {
        reference,
        signableTransaction: {
          reference,
          tx: unsigned.uncheckedSerialize(),
          inputs,
          fee: unsigned.getFee(),
          changeAddress,
        },
      };
    }

    const built = buildPayment({
      utxos,
      ownerAddress: fundingAddress,
      outputs: txOutputs,
      changeAddress,
      privateKeys: fundingKey,
      feePerKb: this.feePerKb,
    });

    await this._recordAction(built, { description, labels, outputs });
    const sent = await this._maybeBroadcast(built, options);

    return {
      txid: built.txid,
      tx: built.rawHex,
      fee: built.fee,
      sent,
    };
  }

  /**
   * Complete a deferred createAction by signing the PINNED input set captured at
   * create time — no UTXO re-fetch, no re-selection, so the resulting transaction is
   * byte-for-byte determined by createAction.
   *
   * @param {object} a
   * @param {string} a.reference
   * @param {Array}  [a.privateKeys] override signing keys (multi-party/offline signers).
   *                 If omitted, the key is re-derived from the action's funding account.
   * @param {object} [a.options] { noSend, acceptDelayedBroadcast }
   */
  async signAction(a = {}) {
    const { reference, privateKeys } = a;
    const pending = await this.storage.getPendingAction(reference);
    if (!pending) throw new Error(`No pending action for reference ${reference}`);

    // No private key is persisted: re-derive it from the recorded funding account
    // (unless the caller supplies an explicit signing key).
    const signingKeys =
      privateKeys || this.keyManager.privateKey(pending.fundingAccount || 'finance');

    const built = buildFromInputs({
      inputs: pending.pinnedInputs, // <- exact same UTXOs as createAction
      ownerAddress: pending.fundingAddress,
      outputs: pending.txOutputs,
      changeAddress: pending.changeAddress,
      privateKeys: signingKeys,
      feePerKb: pending.feePerKb,
    });

    await this.storage.removePendingAction(reference);
    await this._recordAction(built, pending);

    const options = { ...(pending.options || {}), ...(a.options || {}) };
    const sent = await this._maybeBroadcast(built, options);

    return { txid: built.txid, tx: built.rawHex, fee: built.fee, sent };
  }

  async abortAction(a = {}) {
    const removed = await this.storage.removePendingAction(a.reference);
    return { aborted: removed };
  }

  /** List deferred actions awaiting signature. */
  async listPendingActions() {
    const pending = await this.storage.listPendingActions();
    return { totalPendingActions: pending.length, pendingActions: pending };
  }

  /** Broadcast a built tx unless suppressed, updating action status. */
  async _maybeBroadcast(built, options = {}) {
    if (options.noSend || !this.provider) return false;
    try {
      await this.provider.broadcast(built.rawHex);
      await this.storage.updateAction(built.txid, { status: 'completed' });
      return true;
    } catch (e) {
      await this.storage.updateAction(built.txid, { status: 'failed', error: e.message });
      if (!options.acceptDelayedBroadcast) throw e;
      return false;
    }
  }

  async _recordAction(built, meta) {
    await this.storage.insertAction({
      txid: built.txid,
      description: meta.description || '',
      labels: meta.labels || [],
      status: 'unproven',
      fee: built.fee,
    });
    // Record any basketed outputs so they show up in listOutputs.
    (meta.outputs || []).forEach((o, i) => {
      if (o.basket) {
        this.storage.insertOutput({
          basket: o.basket,
          txid: built.txid,
          vout: i,
          satoshis: o.satoshis,
          lockingScript: o.lockingScript,
          tags: o.tags || [],
          customInstructions: o.customInstructions,
          outputDescription: o.outputDescription || '',
        });
      }
    });
  }

  /**
   * Bring an external transaction's outputs into the wallet (e.g. a received payment
   * or ordinal), recording them in a basket.
   */
  async internalizeAction(a = {}) {
    const { tx, outputs = [], description = '' } = a;
    const parsed = typeof tx === 'string' ? new Transaction(tx) : tx;
    const txid = parsed.hash;
    await this.storage.insertAction({
      txid,
      description,
      labels: ['internalized'],
      status: 'unproven',
    });
    for (const o of outputs) {
      const vout = o.outputIndex;
      const out = parsed.outputs[vout];
      await this.storage.insertOutput({
        basket: o.basket || 'default',
        txid,
        vout,
        satoshis: out.satoshis,
        lockingScript: out.script.toHex(),
        tags: o.tags || [],
        outputDescription: o.outputDescription || '',
      });
    }
    return { accepted: true };
  }

  async listActions(a = {}) {
    const actions = await this.storage.listActions(a);
    return { totalActions: actions.length, actions };
  }

  async listOutputs(a = {}) {
    const outputs = await this.storage.listOutputs(a);
    return { totalOutputs: outputs.length, outputs };
  }

  async relinquishOutput(a = {}) {
    const { txid, vout, output } = a;
    const t = txid || (output && output.txid);
    const v = vout !== undefined ? vout : output && output.vout;
    const removed = await this.storage.removeOutput(t, v);
    return { relinquished: removed };
  }

  // ────────────────────────────── certificates ──────────────────────────────

  /**
   * Acquire (store) a certificate. Supports a 'direct' acquisition where the caller
   * supplies a signed certificate, or self-issuance for testing.
   */
  async acquireCertificate(a = {}) {
    const {
      type,
      certifier,
      fields = {},
      serialNumber,
      revocationOutpoint = '',
      signature = '',
      keyringForSubject,
    } = a;
    const cert = {
      type,
      subject: this.keyDeriver.identityKey.toString(),
      certifier,
      serialNumber: serialNumber || crypto.Random.getRandomBuffer(32).toString('hex'),
      fields,
      revocationOutpoint,
      signature,
      keyring: keyringForSubject || {},
    };
    await this.storage.insertCertificate(cert);
    return { certificate: cert };
  }

  async listCertificates(a = {}) {
    const certificates = await this.storage.listCertificates(a);
    return { totalCertificates: certificates.length, certificates };
  }

  /**
   * Produce a verifiable presentation of selected certificate fields for a verifier,
   * with a per-field keyring encrypted to the verifier (BRC-103 selective disclosure).
   */
  async proveCertificate(a = {}) {
    const { certificate, fieldsToReveal = [], verifier } = a;
    const keyringForVerifier = {};
    for (const field of fieldsToReveal) {
      if (!(field in (certificate.fields || {}))) continue;
      const enc = this.cryptoOps.encrypt({
        plaintext: String(certificate.fields[field]),
        protocolID: [2, 'certificate field encryption'],
        keyID: `${certificate.serialNumber} ${field}`,
        counterparty: verifier,
      });
      keyringForVerifier[field] = enc.toString('hex');
    }
    return {
      certificate,
      verifier: String(verifier),
      keyringForVerifier,
    };
  }

  async relinquishCertificate(a = {}) {
    const removed = await this.storage.removeCertificate(a);
    return { relinquished: removed };
  }

  // Discovery requires an overlay/lookup network; not available offline.
  async discoverByIdentityKey() {
    return {
      totalCertificates: 0,
      certificates: [],
      note: 'discovery requires an overlay service',
    };
  }

  async discoverByAttributes() {
    return {
      totalCertificates: 0,
      certificates: [],
      note: 'discovery requires an overlay service',
    };
  }
}

module.exports = { BRC100Wallet, VERSION };
