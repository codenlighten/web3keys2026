'use strict';

const bsv = require('@smartledger/bsv');
const { Transaction, Script, Address } = bsv;
const { coinSelect } = require('./coinSelect');

const DUST = 1; // BSV has effectively no dust limit; 1 sat outputs are valid (ordinals).

/** Resolve a UTXO's locking script, reconstructing P2PKH from `ownerAddress` if absent. */
function resolveScript(utxo, ownerAddress) {
  if (utxo.script) return utxo.script;
  if (!ownerAddress) {
    throw new Error(`UTXO ${utxo.txid}:${utxo.vout} has no script and no owner address`);
  }
  return Script.buildPublicKeyHashOut(new Address(ownerAddress)).toHex();
}

/** Normalise a provider UTXO into the shape bsv's Transaction.from() expects. */
function toTxInput(utxo, ownerAddress) {
  return {
    txId: utxo.txid,
    outputIndex: utxo.vout,
    script: resolveScript(utxo, ownerAddress),
    satoshis: utxo.satoshis,
  };
}

/**
 * Resolve provider UTXOs into a stable, self-contained "pinned" shape: each carries
 * its locking script and satoshis, so the exact same inputs can be rebuilt later
 * (e.g. in signAction) with no network round-trip and no re-selection.
 */
function resolveUtxos(utxos, ownerAddress) {
  return utxos.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    satoshis: u.satoshis,
    script: resolveScript(u, ownerAddress),
  }));
}

/** Actual bsv-computed change in satoshis (0 if no change output). */
function changeOf(tx) {
  const out = tx.getChangeOutput();
  return out ? out.satoshis : 0;
}

/**
 * Assemble an UNSIGNED transaction from an explicit, pre-selected input set.
 * Performs NO coin selection — inputs are used exactly as given, in order.
 *
 * @param {object} p
 * @param {Array}  p.inputs        pinned UTXOs (provider shape; scripts resolved)
 * @param {string} [p.ownerAddress] fallback owner for any input missing a script
 * @param {Array}  p.outputs       [{ to, satoshis }] OR [{ script: hex, satoshis }]
 * @param {string} [p.changeAddress]
 * @param {number} [p.feePerKb]
 * @param {Array}  [p.dataOutputs] OP_RETURN payloads
 * @returns {Transaction} unsigned transaction
 */
function assembleUnsigned({
  inputs,
  ownerAddress,
  outputs = [],
  changeAddress,
  feePerKb = 50,
  dataOutputs = [],
}) {
  const tx = new Transaction();
  tx.feePerKb(feePerKb);
  for (const u of inputs) {
    tx.from(toTxInput(u, ownerAddress));
  }
  for (const o of outputs) {
    if (o.script) {
      tx.addOutput(
        new Transaction.Output({ script: Script.fromHex(o.script), satoshis: o.satoshis })
      );
    } else {
      tx.to(new Address(o.to), o.satoshis);
    }
  }
  for (const d of dataOutputs) {
    tx.addData(d);
  }
  if (changeAddress) tx.change(new Address(changeAddress));
  return tx;
}

/** Sign and finalise a transaction, returning the standard result object. */
function finalize(tx, privateKeys) {
  const keys = Array.isArray(privateKeys) ? privateKeys : [privateKeys];
  tx.sign(keys);
  if (!tx.isFullySigned()) {
    throw new Error('Transaction is not fully signed (missing keys for some inputs)');
  }
  return {
    tx,
    txid: tx.hash,
    fee: tx.getFee(),
    change: changeOf(tx),
    // uncheckedSerialize skips the library's stale dust/fee policy checks (1-sat
    // ordinal outputs are legitimate on BSV). We guard isFullySigned ourselves above.
    rawHex: tx.uncheckedSerialize(),
  };
}

/**
 * Build and sign a transaction from an EXPLICIT, pre-selected input set.
 * Deterministic: the same inputs + outputs always produce the same transaction.
 * This is the input-pinned path used by deferred createAction → signAction.
 */
function buildFromInputs(p) {
  const tx = assembleUnsigned(p);
  return finalize(tx, p.privateKeys);
}

/**
 * Select inputs to cover the outputs (+ fee) and resolve them to the pinned shape.
 * Throws if funds are insufficient. Returns { inputs, sel }.
 */
function selectInputs({ utxos, ownerAddress, outputs = [], dataOutputs = [], feePerKb = 50 }) {
  const target = outputs.reduce((s, o) => s + o.satoshis, 0);
  const sel = coinSelect(utxos, target, {
    feePerKb,
    numOutputs: outputs.length + dataOutputs.length + 1,
  });
  if (!sel.enough) {
    throw new Error(
      `Insufficient funds: need ${target}+fee, have ${sel.total} across ${utxos.length} utxo(s)`
    );
  }
  return { inputs: resolveUtxos(sel.selected, ownerAddress), sel };
}

/**
 * Convenience: select inputs from a UTXO pool, then build + sign.
 * (Coin selection happens here; for pinned/offline flows use selectInputs +
 * buildFromInputs separately so the input set is fixed before signing.)
 *
 * @returns {{ tx, txid, fee, change, rawHex }}
 */
function buildPayment(p) {
  const { inputs } = selectInputs(p);
  return buildFromInputs({ ...p, inputs });
}

module.exports = {
  DUST,
  toTxInput,
  resolveScript,
  resolveUtxos,
  changeOf,
  assembleUnsigned,
  finalize,
  buildFromInputs,
  selectInputs,
  buildPayment,
};
