'use strict';

const db = require('./db');
const svc = require('./walletService');
const { logger } = require('./logger');

/**
 * Incoming-payment detection. Scans a user's finance-xpub addresses (gap limit) for
 * deposits not yet recorded, and for each new one records an 'in' transaction and a
 * 'deposit' notification. Idempotent: re-running does not duplicate. The provider is
 * injectable for testing (defaults to the shared WhatsOnChain provider).
 */
async function syncUserDeposits(user, { provider = svc.provider, gap = 5 } = {}) {
  // Deposits only land on addresses we've handed out (0..receive_index). Scan that
  // bounded range + a small gap — NOT a fresh 20-address gap-limit walk every cycle —
  // to keep the chain-provider request volume low and avoid rate limiting.
  const maxIndex = (Number(user.receive_index) || 0) + gap;
  const seen = await db.incomingOutpoints(user.id);
  const created = [];
  for (let i = 0; i <= maxIndex; i++) {
    const address = svc.depositAddress(user, i);

    const utxos = await provider.getUtxos(address);
    if (!utxos.length) {
      continue;
    }
    for (const u of utxos) {
      const key = `${u.txid}:${u.vout}`;
      if (seen.has(key)) continue;
      seen.add(key);

      await db.insertTransaction({
        txid: u.txid,
        userId: user.id,
        direction: 'in',
        amountSats: u.satoshis,
        address,
        vout: u.vout,
        status: 'confirmed',
      });

      const n = await db.insertNotification({
        userId: user.id,
        type: 'deposit',
        payload: { txid: u.txid, vout: u.vout, satoshis: u.satoshis, address },
      });
      created.push(n);
    }
  }
  return created;
}

/** Sweep all verified users for new deposits. Returns the total number of new deposits. */
async function syncAll(opts = {}) {
  const users = await db.listUsers();
  let total = 0;
  for (const user of users) {
    try {
      const created = await syncUserDeposits(user, opts);
      total += created.length;
    } catch (err) {
      logger.error({ err, userId: user.id }, 'deposit sync failed for user');
    }
  }
  return total;
}

module.exports = { syncUserDeposits, syncAll };
