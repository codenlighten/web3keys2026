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
async function syncUserDeposits(
  user,
  { provider = svc.provider, gapLimit = 20, maxIndex = 200 } = {}
) {
  const seen = await db.incomingOutpoints(user.id);
  const created = [];
  let empty = 0;
  for (let i = 0; i <= maxIndex && empty < gapLimit; i++) {
    const address = svc.depositAddress(user, i);
    // eslint-disable-next-line no-await-in-loop
    const utxos = await provider.getUtxos(address);
    if (!utxos.length) {
      empty += 1;
      continue;
    }
    empty = 0;
    for (const u of utxos) {
      const key = `${u.txid}:${u.vout}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // eslint-disable-next-line no-await-in-loop
      await db.insertTransaction({
        txid: u.txid,
        userId: user.id,
        direction: 'in',
        amountSats: u.satoshis,
        address,
        vout: u.vout,
        status: 'confirmed',
      });
      // eslint-disable-next-line no-await-in-loop
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
      // eslint-disable-next-line no-await-in-loop
      const created = await syncUserDeposits(user, opts);
      total += created.length;
    } catch (err) {
      logger.error({ err, userId: user.id }, 'deposit sync failed for user');
    }
  }
  return total;
}

module.exports = { syncUserDeposits, syncAll };
