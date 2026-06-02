'use strict';

/**
 * Simple, deterministic coin selection.
 * Sorts UTXOs ascending and accumulates until the target (+ estimated fee) is met.
 * Returns { selected, total, change, fee, enough }.
 *
 * Fee model: feePerKb sats per 1000 bytes. We estimate size as
 *   inputs * 148 + outputs * 34 + 10  (standard P2PKH heuristic).
 */
function coinSelect(utxos, targetSatoshis, { feePerKb = 50, numOutputs = 2 } = {}) {
  const sorted = [...utxos].sort((a, b) => a.satoshis - b.satoshis);
  const selected = [];
  let total = 0;

  const estimateFee = (numInputs) => {
    const bytes = numInputs * 148 + numOutputs * 34 + 10;
    return Math.ceil((bytes / 1000) * feePerKb);
  };

  for (const u of sorted) {
    selected.push(u);
    total += u.satoshis;
    const fee = estimateFee(selected.length);
    if (total >= targetSatoshis + fee) {
      return {
        selected,
        total,
        fee,
        change: total - targetSatoshis - fee,
        enough: true,
      };
    }
  }

  const fee = estimateFee(selected.length);
  return { selected, total, fee, change: 0, enough: false };
}

module.exports = { coinSelect };
