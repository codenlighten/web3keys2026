'use strict';

const bsv = require('@smartledger/bsv');
const { Script, Opcode, Address } = bsv;
const { buildPayment, toTxInput } = require('../tx/TxBuilder');

const ORD_SATS = 1; // 1Sat Ordinals: each inscription/ordinal sits on exactly one satoshi.

/**
 * Build a 1Sat Ordinals inscription locking script:
 *
 *   <P2PKH to ownerAddress>
 *   OP_FALSE OP_IF "ord" OP_1 <contentType> OP_0 <data> OP_ENDIF
 *
 * The P2PKH prefix keeps the output spendable/transferable; the envelope carries
 * the inscription. This is the de-facto 1Sat Ordinals format on BSV.
 */
function buildInscriptionScript(ownerAddress, data, contentType = 'text/plain') {
  const addr = new Address(ownerAddress);
  const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const ct = Buffer.isBuffer(contentType) ? contentType : Buffer.from(contentType, 'utf8');

  return Script.buildPublicKeyHashOut(addr)
    .add(Opcode.OP_FALSE)
    .add(Opcode.OP_IF)
    .add(Buffer.from('ord', 'utf8'))
    .add(Opcode.OP_1)
    .add(ct)
    .add(Opcode.OP_0)
    .add(body)
    .add(Opcode.OP_ENDIF);
}

/**
 * Parse an inscription out of a locking script. Returns { contentType, data } or null.
 */
function parseInscription(script) {
  const s = typeof script === 'string' ? Script.fromHex(script) : script;
  const chunks = s.chunks;
  // Find the OP_FALSE OP_IF "ord" envelope start.
  for (let i = 0; i < chunks.length - 1; i++) {
    const isFalse = chunks[i].opcodenum === Opcode.OP_FALSE;
    const isIf = chunks[i + 1] && chunks[i + 1].opcodenum === Opcode.OP_IF;
    const marker = chunks[i + 2] && chunks[i + 2].buf;
    if (isFalse && isIf && marker && marker.toString('utf8') === 'ord') {
      // chunks: [.. OP_FALSE, OP_IF, "ord", OP_1, ct, OP_0, data, OP_ENDIF]
      const ct = chunks[i + 4] && chunks[i + 4].buf;
      const data = chunks[i + 6] && chunks[i + 6].buf;
      return {
        contentType: ct ? ct.toString('utf8') : null,
        data: data || Buffer.alloc(0),
      };
    }
  }
  return null;
}

/**
 * Create an inscription transaction. Funds come from `fundingUtxos`; the resulting
 * 1-sat inscription output is locked to `ownerAddress`.
 *
 * @returns {{ tx, txid, rawHex, fee, change, ordinalVout }}
 */
function inscribe({
  fundingUtxos,
  fundingAddress,
  ownerAddress,
  data,
  contentType = 'text/plain',
  changeAddress,
  privateKeys,
  feePerKb = 50,
}) {
  const inscriptionScript = buildInscriptionScript(ownerAddress, data, contentType);
  const result = buildPayment({
    utxos: fundingUtxos,
    ownerAddress: fundingAddress,
    outputs: [{ script: inscriptionScript.toHex(), satoshis: ORD_SATS }],
    changeAddress,
    privateKeys,
    feePerKb,
  });
  return { ...result, ordinalVout: 0 };
}

/**
 * Transfer an existing ordinal (a 1-sat UTXO) to a new owner.
 * The ordinal UTXO is spent as input 0 and recreated as a plain P2PKH 1-sat output
 * to `toAddress`; `fundingUtxos` pay the miner fee, change goes to `changeAddress`.
 *
 * @returns {{ tx, txid, rawHex, fee, change }}
 */
function transfer({
  ordinalUtxo,
  ordinalOwnerAddress,
  toAddress,
  fundingUtxos = [],
  fundingAddress,
  changeAddress,
  privateKeys,
  feePerKb = 50,
}) {
  // Place the ordinal as the first input so its satoshi maps to the first output.
  const utxos = [ordinalUtxo, ...fundingUtxos];
  // We need the ordinal input's owner address for script reconstruction; build inputs
  // through buildPayment but pass a per-utxo owner via pre-normalised scripts.
  const normalised = utxos.map((u) =>
    toTxInput(u, u === ordinalUtxo ? ordinalOwnerAddress : fundingAddress)
  );

  // buildPayment re-normalises, so feed already-scripted utxos back in provider shape.
  const scripted = normalised.map((i) => ({
    txid: i.txId,
    vout: i.outputIndex,
    script: i.script,
    satoshis: i.satoshis,
  }));

  return buildPayment({
    utxos: scripted,
    outputs: [{ to: toAddress, satoshis: ORD_SATS }],
    changeAddress,
    privateKeys,
    feePerKb,
  });
}

module.exports = {
  ORD_SATS,
  buildInscriptionScript,
  parseInscription,
  inscribe,
  transfer,
};
