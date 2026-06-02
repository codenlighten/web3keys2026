'use strict';

/**
 * HD derivation paths for the web3keys2 BSV wallet.
 *
 * Three logical accounts live under BIP-44 (m/44'/coinType'/account'/change/index).
 * Note the deliberate coin-type split:
 *   - identity & tokens use BSV's registered SLIP-44 coin type 236
 *   - finance/funds uses the legacy Bitcoin coin type 0 (as historically used by
 *     several BSV wallets for spendable funds)
 */

const COIN = {
  BSV: 236,
  BTC_LEGACY: 0,
};

/**
 * Account definitions. Each entry is the path *prefix* down to the account level
 * (m/44'/coin'/account'). Addresses are derived by appending `/change/index`.
 */
const ACCOUNTS = {
  identity: {
    name: 'identity',
    coinType: COIN.BSV,
    account: 0,
    purpose: 'Identity keys, message signing, DID, BRC-100 authentication',
  },
  finance: {
    name: 'finance',
    coinType: COIN.BTC_LEGACY,
    account: 0,
    purpose: 'Spendable BSV funds (payments, change)',
  },
  tokens: {
    name: 'tokens',
    coinType: COIN.BSV,
    account: 2,
    purpose: '1Sat Ordinals, inscriptions and tokens',
  },
};

/** Build a full BIP-44 path string. */
function buildPath(account, { change = 0, index = 0 } = {}) {
  const a = ACCOUNTS[account] || account;
  if (!a || typeof a.coinType !== 'number') {
    throw new Error(`Unknown account: ${account}`);
  }
  return `m/44'/${a.coinType}'/${a.account}'/${change}/${index}`;
}

/** Path prefix down to the account level, e.g. m/44'/236'/0'. */
function accountPath(account) {
  const a = ACCOUNTS[account] || account;
  return `m/44'/${a.coinType}'/${a.account}'`;
}

module.exports = { COIN, ACCOUNTS, buildPath, accountPath };
