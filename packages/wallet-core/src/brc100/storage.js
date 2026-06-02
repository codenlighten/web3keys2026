'use strict';

/**
 * WalletStorage is the persistence interface the BRC-100 wallet relies on for
 * stateful concepts: output baskets, certificates, action history, and pending
 * (deferred, input-pinned) actions awaiting signature.
 *
 * The default MemoryStorage keeps everything in RAM. Implement the same surface
 * backed by a DB/file to persist a real wallet — in particular, a durable
 * implementation lets a deferred createAction → signAction session survive a
 * process restart. Pending-action records are plain JSON and never contain keys.
 */
class MemoryStorage {
  constructor() {
    this.outputs = []; // { basket, txid, vout, satoshis, lockingScript, spendable, tags, customInstructions, outputDescription }
    this.certificates = []; // BRC-103 style certificate records
    this.actions = []; // { txid, description, status, labels, inputs, outputs, ... }
    this.pendingActions = new Map(); // reference -> pinned action record (JSON-serializable, no keys)
  }

  // --- Pending (deferred) actions ---
  // Records are plain JSON (pinned inputs, outputs, funding account, etc.) and MUST NOT
  // contain private keys — signAction re-derives the signing key from the funding account.
  async insertPendingAction(reference, record) {
    this.pendingActions.set(reference, record);
    return record;
  }

  async getPendingAction(reference) {
    return this.pendingActions.get(reference) || null;
  }

  async removePendingAction(reference) {
    return this.pendingActions.delete(reference);
  }

  async listPendingActions() {
    return [...this.pendingActions.entries()].map(([reference, record]) => ({
      reference,
      ...record,
    }));
  }

  // --- Outputs / baskets ---
  async insertOutput(output) {
    this.outputs.push({ spendable: true, tags: [], ...output });
    return output;
  }

  async listOutputs({ basket, tags, includeSpent = false } = {}) {
    return this.outputs.filter((o) => {
      if (basket && o.basket !== basket) return false;
      if (!includeSpent && !o.spendable) return false;
      if (tags && tags.length && !tags.every((t) => (o.tags || []).includes(t))) return false;
      return true;
    });
  }

  async markSpent(txid, vout) {
    const o = this.outputs.find((x) => x.txid === txid && x.vout === vout);
    if (o) o.spendable = false;
    return !!o;
  }

  async removeOutput(txid, vout) {
    const i = this.outputs.findIndex((x) => x.txid === txid && x.vout === vout);
    if (i >= 0) this.outputs.splice(i, 1);
    return i >= 0;
  }

  // --- Certificates ---
  async insertCertificate(cert) {
    this.certificates.push(cert);
    return cert;
  }

  async listCertificates({ certifiers, types } = {}) {
    return this.certificates.filter((c) => {
      if (certifiers && certifiers.length && !certifiers.includes(c.certifier)) return false;
      if (types && types.length && !types.includes(c.type)) return false;
      return true;
    });
  }

  async removeCertificate({ type, serialNumber, certifier }) {
    const i = this.certificates.findIndex(
      (c) =>
        (!type || c.type === type) &&
        (!serialNumber || c.serialNumber === serialNumber) &&
        (!certifier || c.certifier === certifier)
    );
    if (i >= 0) this.certificates.splice(i, 1);
    return i >= 0;
  }

  // --- Actions (transaction history) ---
  async insertAction(action) {
    this.actions.push(action);
    return action;
  }

  async updateAction(txid, patch) {
    const a = this.actions.find((x) => x.txid === txid);
    if (a) Object.assign(a, patch);
    return a;
  }

  async listActions({ labels, status } = {}) {
    return this.actions.filter((a) => {
      if (status && a.status !== status) return false;
      if (labels && labels.length && !labels.every((l) => (a.labels || []).includes(l)))
        return false;
      return true;
    });
  }
}

module.exports = { MemoryStorage };
