'use strict';

/**
 * SqliteStorage — a durable WalletStorage backed by the built-in `node:sqlite`
 * module (Node 18.19+/20.6+/22+). Drop-in replacement for MemoryStorage: same async
 * surface (outputs/baskets, certificates, action history, pending actions).
 *
 * Because pending actions are persisted here (and never contain private keys), a
 * deferred createAction → signAction session survives a process restart:
 *
 *   const storage = new SqliteStorage('./wallet.db');
 *   const wallet = Wallet.fromMnemonic(mnemonic, { storage, provider });
 *   // ... later, in a fresh process, reopen the same file and signAction(reference).
 *
 * node:sqlite is lazy-required in the constructor so merely importing the package
 * doesn't emit the experimental-feature warning for users who don't use this class.
 */
class SqliteStorage {
  /** @param {string} [filename] path to the db file, or ':memory:' (default). */
  constructor(filename = ':memory:') {
    // eslint-disable-next-line global-require
    const { DatabaseSync } = require('node:sqlite');
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
    }
    this.db.exec('PRAGMA foreign_keys = ON;');
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outputs (
        txid TEXT NOT NULL,
        vout INTEGER NOT NULL,
        basket TEXT,
        satoshis INTEGER NOT NULL,
        lockingScript TEXT,
        spendable INTEGER NOT NULL DEFAULT 1,
        tags TEXT NOT NULL DEFAULT '[]',
        customInstructions TEXT,
        outputDescription TEXT,
        PRIMARY KEY (txid, vout)
      );
      CREATE INDEX IF NOT EXISTS idx_outputs_basket ON outputs(basket);

      CREATE TABLE IF NOT EXISTS certificates (
        serialNumber TEXT PRIMARY KEY,
        type TEXT,
        subject TEXT,
        certifier TEXT,
        fields TEXT NOT NULL DEFAULT '{}',
        revocationOutpoint TEXT,
        signature TEXT,
        keyring TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS actions (
        txid TEXT PRIMARY KEY,
        description TEXT,
        status TEXT,
        labels TEXT NOT NULL DEFAULT '[]',
        fee INTEGER,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS pending_actions (
        reference TEXT PRIMARY KEY,
        record TEXT NOT NULL
      );
    `);
  }

  // ────────────────────────────── outputs / baskets ──────────────────────────────

  async insertOutput(output) {
    const o = { spendable: true, tags: [], ...output };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO outputs
           (txid, vout, basket, satoshis, lockingScript, spendable, tags, customInstructions, outputDescription)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        o.txid,
        o.vout,
        o.basket ?? null,
        o.satoshis,
        o.lockingScript ?? null,
        o.spendable ? 1 : 0,
        JSON.stringify(o.tags || []),
        o.customInstructions ?? null,
        o.outputDescription ?? null
      );
    return output;
  }

  async listOutputs({ basket, tags, includeSpent = false } = {}) {
    let sql = 'SELECT * FROM outputs WHERE 1=1';
    const params = [];
    if (basket) {
      sql += ' AND basket = ?';
      params.push(basket);
    }
    if (!includeSpent) sql += ' AND spendable = 1';
    let rows = this.db.prepare(sql).all(...params).map(rowToOutput);
    if (tags && tags.length) {
      rows = rows.filter((o) => tags.every((t) => o.tags.includes(t)));
    }
    return rows;
  }

  async markSpent(txid, vout) {
    const info = this.db
      .prepare('UPDATE outputs SET spendable = 0 WHERE txid = ? AND vout = ?')
      .run(txid, vout);
    return info.changes > 0;
  }

  async removeOutput(txid, vout) {
    const info = this.db
      .prepare('DELETE FROM outputs WHERE txid = ? AND vout = ?')
      .run(txid, vout);
    return info.changes > 0;
  }

  // ────────────────────────────── certificates ──────────────────────────────

  async insertCertificate(cert) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO certificates
           (serialNumber, type, subject, certifier, fields, revocationOutpoint, signature, keyring)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        cert.serialNumber,
        cert.type ?? null,
        cert.subject ?? null,
        cert.certifier ?? null,
        JSON.stringify(cert.fields || {}),
        cert.revocationOutpoint ?? null,
        cert.signature ?? null,
        JSON.stringify(cert.keyring || {})
      );
    return cert;
  }

  async listCertificates({ certifiers, types } = {}) {
    let rows = this.db.prepare('SELECT * FROM certificates').all().map(rowToCert);
    if (certifiers && certifiers.length) rows = rows.filter((c) => certifiers.includes(c.certifier));
    if (types && types.length) rows = rows.filter((c) => types.includes(c.type));
    return rows;
  }

  async removeCertificate({ type, serialNumber, certifier } = {}) {
    // Match MemoryStorage: remove the first matching certificate.
    const conds = [];
    const params = [];
    if (type) {
      conds.push('type = ?');
      params.push(type);
    }
    if (serialNumber) {
      conds.push('serialNumber = ?');
      params.push(serialNumber);
    }
    if (certifier) {
      conds.push('certifier = ?');
      params.push(certifier);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const row = this.db.prepare(`SELECT rowid FROM certificates ${where} LIMIT 1`).get(...params);
    if (!row) return false;
    this.db.prepare('DELETE FROM certificates WHERE rowid = ?').run(row.rowid);
    return true;
  }

  // ────────────────────────────── actions ──────────────────────────────

  async insertAction(action) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO actions (txid, description, status, labels, fee, error)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        action.txid,
        action.description ?? null,
        action.status ?? null,
        JSON.stringify(action.labels || []),
        action.fee ?? null,
        action.error ?? null
      );
    return action;
  }

  async updateAction(txid, patch) {
    const current = this.db.prepare('SELECT * FROM actions WHERE txid = ?').get(txid);
    if (!current) return undefined;
    const merged = { ...rowToAction(current), ...patch };
    await this.insertAction(merged);
    return merged;
  }

  async listActions({ labels, status } = {}) {
    let sql = 'SELECT * FROM actions';
    const params = [];
    if (status) {
      sql += ' WHERE status = ?';
      params.push(status);
    }
    let rows = this.db.prepare(sql).all(...params).map(rowToAction);
    if (labels && labels.length) {
      rows = rows.filter((a) => labels.every((l) => a.labels.includes(l)));
    }
    return rows;
  }

  // ────────────────────────────── pending actions ──────────────────────────────

  async insertPendingAction(reference, record) {
    this.db
      .prepare('INSERT OR REPLACE INTO pending_actions (reference, record) VALUES (?, ?)')
      .run(reference, JSON.stringify(record));
    return record;
  }

  async getPendingAction(reference) {
    const row = this.db.prepare('SELECT record FROM pending_actions WHERE reference = ?').get(reference);
    return row ? JSON.parse(row.record) : null;
  }

  async removePendingAction(reference) {
    const info = this.db
      .prepare('DELETE FROM pending_actions WHERE reference = ?')
      .run(reference);
    return info.changes > 0;
  }

  async listPendingActions() {
    return this.db
      .prepare('SELECT reference, record FROM pending_actions')
      .all()
      .map((r) => ({ reference: r.reference, ...JSON.parse(r.record) }));
  }

  /** Close the underlying database handle. */
  close() {
    this.db.close();
  }
}

function rowToOutput(r) {
  return {
    txid: r.txid,
    vout: r.vout,
    basket: r.basket,
    satoshis: r.satoshis,
    lockingScript: r.lockingScript,
    spendable: !!r.spendable,
    tags: JSON.parse(r.tags || '[]'),
    customInstructions: r.customInstructions,
    outputDescription: r.outputDescription,
  };
}

function rowToCert(r) {
  return {
    serialNumber: r.serialNumber,
    type: r.type,
    subject: r.subject,
    certifier: r.certifier,
    fields: JSON.parse(r.fields || '{}'),
    revocationOutpoint: r.revocationOutpoint,
    signature: r.signature,
    keyring: JSON.parse(r.keyring || '{}'),
  };
}

function rowToAction(r) {
  return {
    txid: r.txid,
    description: r.description,
    status: r.status,
    labels: JSON.parse(r.labels || '[]'),
    fee: r.fee,
    error: r.error,
  };
}

module.exports = { SqliteStorage };
