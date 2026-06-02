'use strict';

const bsv = require('@smartledger/bsv');
const { Shamir, Mnemonic } = bsv;

/**
 * Threshold custody helpers (BRC-style 2-of-3 Shamir secret sharing over the wallet
 * mnemonic). The wallet's seed is split into three shares; ANY TWO reconstruct it, ANY
 * ONE reveals nothing.
 *
 * Role assignment used by the web3keys service (see server Phase 2):
 *   - share 1 → USER recovery share (held off-box by the user)
 *   - share 2 → SERVICE share (stored encrypted under the user's password)
 *   - share 3 → TTP-bound share (stored encrypted under a server master key; later
 *               migrates to a trusted third party)
 *
 * Operational signing combines shares 2 + 3; recovery combines share 1 + share 3.
 *
 * NOTE (by design): reconstruct() reassembles the full mnemonic in memory. That is the
 * Shamir model. A future hardening replaces reconstruction with threshold-ECDSA (MPC)
 * so the key never fully assembles — out of scope here.
 */

const ROLES = { user: 0, service: 1, ttp: 2 };

/** Serialize a Shamir share object to a compact, transport/storage-safe string. */
function serializeShare(share) {
  return Buffer.from(JSON.stringify(share), 'utf8').toString('base64');
}

function deserializeShare(str) {
  return JSON.parse(Buffer.from(str, 'base64').toString('utf8'));
}

/**
 * Split a mnemonic into 2-of-3 shares, returned as serialized strings keyed by role.
 * @param {string} mnemonic BIP-39 phrase
 * @returns {{ user: string, service: string, ttp: string }}
 */
function splitSeed(mnemonic) {
  if (!mnemonic || !Mnemonic.isValid(mnemonic)) {
    throw new Error('splitSeed requires a valid BIP-39 mnemonic');
  }
  const secret = Buffer.from(mnemonic, 'utf8');
  const shares = Shamir.split(secret, 2, 3); // (secret, threshold, totalShares)
  return {
    user: serializeShare(shares[ROLES.user]),
    service: serializeShare(shares[ROLES.service]),
    ttp: serializeShare(shares[ROLES.ttp]),
  };
}

/**
 * Reconstruct the mnemonic from any two (or three) serialized shares.
 * @param {string[]} shareStrings 2+ serialized shares
 * @returns {string} mnemonic
 */
function reconstruct(shareStrings) {
  if (!Array.isArray(shareStrings) || shareStrings.length < 2) {
    throw new Error('reconstruct requires at least 2 shares');
  }
  const shares = shareStrings.map(deserializeShare);
  const secret = Shamir.combine(shares);
  const mnemonic = Buffer.isBuffer(secret) ? secret.toString('utf8') : String(secret);
  if (!Mnemonic.isValid(mnemonic)) {
    throw new Error('reconstruction failed: combined shares did not yield a valid mnemonic');
  }
  return mnemonic;
}

/** True if a serialized share is structurally a valid Shamir share. */
function verifyShare(shareString) {
  try {
    return Shamir.verifyShare(deserializeShare(shareString));
  } catch {
    return false;
  }
}

module.exports = { ROLES, splitSeed, reconstruct, verifyShare, serializeShare, deserializeShare };
