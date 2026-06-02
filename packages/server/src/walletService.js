'use strict';

const { WhatsOnChainProvider, bsv } = require('@web3keys/wallet-core');
const { config } = require('./config');
const db = require('./db');
const security = require('./security');
const { ServiceError } = require('./errors');
const { makeClient } = require('./paymailClient');
const { sendOtpEmail } = require('./mailer');

/**
 * walletService — NON-CUSTODIAL. The server never generates, holds, or reconstructs any
 * wallet key. Keys are created and used client-side; at registration the client supplies
 * only PUBLIC values (xpubs + identity public key). The server's wallet role is limited
 * to read-only data (addresses/balance/UTXOs derived from the public xpub) and
 * broadcasting client-signed transactions.
 */

const provider = new WhatsOnChainProvider({ network: config.network, apiKey: config.wocApiKey });
const paymailClient = makeClient();

function net() {
  return provider.network === 'testnet' ? bsv.Networks.testnet : bsv.Networks.livenet;
}

function deriveFromXpub(xpub, index) {
  return bsv.HDPublicKey.fromString(xpub)
    .deriveChild(0)
    .deriveChild(index)
    .publicKey.toAddress(net())
    .toString();
}

function assertXpub(label, x) {
  try {
    bsv.HDPublicKey.fromString(x);
  } catch {
    throw new ServiceError(`Invalid ${label}`, 400);
  }
}
function assertPubkey(label, p) {
  try {
    bsv.PublicKey.fromString(p);
  } catch {
    throw new ServiceError(`Invalid ${label}`, 400);
  }
}

function sanitizeAlias(email) {
  return (
    email
      .split('@')[0]
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '')
      .slice(0, 32) || 'user'
  );
}

async function uniqueAlias(email) {
  const base = sanitizeAlias(email);
  let alias = base;
  let n = 0;
  while (await db.findByAlias(alias)) {
    n += 1;
    alias = `${base}${n}`;
  }
  return alias;
}

function depositAddress(user, index = 0) {
  return deriveFromXpub(user.finance_xpub, index);
}

function receiveAddress(user) {
  return deriveFromXpub(user.finance_xpub, user.receive_index || 0);
}

function publicProfile(user) {
  return {
    email: user.email,
    paymail: `${user.alias}@${config.domain}`,
    alias: user.alias,
    identityKey: user.identity_pubkey,
    address: depositAddress(user),
    verified: !!user.verified,
  };
}

async function issueOtp(email, purpose) {
  const code = security.generateOtp();
  await db.upsertOtp({
    email,
    purpose,
    codeHash: security.hashOtp(code),
    expiresAt: Date.now() + config.otpTtlMs,
  });
  await sendOtpEmail(email, code, purpose);
}

/**
 * Register a NON-CUSTODIAL account. The client generates the wallet and supplies only
 * public material; the server stores no key/seed/share. Returns the profile (no seed).
 */
async function register({ email, password, identityKey, financeXpub, tokensXpub, identityXpub }) {
  email = String(email || '')
    .trim()
    .toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ServiceError('Invalid email');
  if (!password || String(password).length < 8) {
    throw new ServiceError('Password must be at least 8 characters');
  }
  assertPubkey('identity key', identityKey);
  assertXpub('finance xpub', financeXpub);
  assertXpub('tokens xpub', tokensXpub);
  assertXpub('identity xpub', identityXpub);
  if (await db.findByEmail(email)) throw new ServiceError('Email already registered', 409);

  const alias = await uniqueAlias(email);
  const user = await db.createUser({
    email,
    alias,
    passwordVerifier: security.hashPassword(password),
    identityPubkey: identityKey,
    financeXpub,
    tokensXpub,
    identityXpub,
    verified: false,
  });

  await issueOtp(email, 'register');
  return { profile: publicProfile(user), otpSent: true };
}

async function verifyRegistration({ email, code }) {
  email = String(email || '')
    .trim()
    .toLowerCase();
  const otp = await db.getOtp(email, 'register');
  if (!otp) throw new ServiceError('No pending verification', 404);
  if (Date.now() > otp.expires_at) {
    await db.deleteOtp(email, 'register');
    throw new ServiceError('Code expired', 410);
  }
  if (otp.attempts >= 5) {
    await db.deleteOtp(email, 'register');
    throw new ServiceError('Too many attempts', 429);
  }
  if (security.hashOtp(String(code)) !== otp.code_hash) {
    await db.incrementOtpAttempts(email, 'register');
    throw new ServiceError('Invalid code', 401);
  }
  await db.setVerified(email);
  await db.deleteOtp(email, 'register');
  return publicProfile(await db.findByEmail(email));
}

/**
 * Authenticate an ACCOUNT (not a wallet — there is no server-side key to unlock).
 * Verifies the password; returns the user row. 2FA is enforced by the caller.
 */
async function authenticate({ email, password }) {
  email = String(email || '')
    .trim()
    .toLowerCase();
  const user = await db.findByEmail(email);
  if (!user) throw new ServiceError('Invalid credentials', 401);
  if (!user.verified) throw new ServiceError('Email not verified', 403);
  if (!security.verifyPassword(password, user.password_verifier)) {
    throw new ServiceError('Invalid credentials', 401);
  }
  return { user };
}

// ── read-only chain data (no keys) ──────────────────────────────────────────────

async function scanXpubSatoshis(user, { gapLimit = 20, maxIndex = 500 } = {}) {
  let total = 0;
  let empty = 0;
  for (let i = 0; i <= maxIndex && empty < gapLimit; i++) {
    const utxos = await provider.getUtxos(deriveFromXpub(user.finance_xpub, i));
    if (!utxos.length) {
      empty += 1;
      continue;
    }
    empty = 0;
    total += utxos.reduce((s, u) => s + u.satoshis, 0);
  }
  return total;
}

async function getBalance(user) {
  return { confirmed: await scanXpubSatoshis(user), unconfirmed: 0 };
}

async function rotateReceiveAddress(user) {
  const index = await db.bumpReceiveIndex(user.email);
  return { address: deriveFromXpub(user.finance_xpub, index), index };
}

/**
 * Spendable UTXOs for the finance account, each tagged with its derivation index so the
 * CLIENT can derive the matching key and sign locally. The server never signs.
 */
async function getSpendableUtxos(user, { gapLimit = 20, maxIndex = 500 } = {}) {
  const out = [];
  let empty = 0;
  for (let i = 0; i <= maxIndex && empty < gapLimit; i++) {
    const address = deriveFromXpub(user.finance_xpub, i);

    const utxos = await provider.getUtxos(address);
    if (!utxos.length) {
      empty += 1;
      continue;
    }
    empty = 0;
    const script = bsv.Script.buildPublicKeyHashOut(new bsv.Address(address)).toHex();
    for (const u of utxos) {
      out.push({
        txid: u.txid,
        vout: u.vout,
        satoshis: u.satoshis,
        script: u.script || script,
        address,
        change: 0,
        index: i,
      });
    }
  }
  return out;
}

/** List the user's ordinals (1-sat UTXOs under the tokens xpub) — read-only. */
async function listOrdinals(user, { gapLimit = 20, maxIndex = 200 } = {}) {
  const out = [];
  let empty = 0;
  for (let i = 0; i <= maxIndex && empty < gapLimit; i++) {
    const address = bsv.HDPublicKey.fromString(user.tokens_xpub)
      .deriveChild(0)
      .deriveChild(i)
      .publicKey.toAddress(net())
      .toString();

    const utxos = await provider.getOrdinalUtxos(address);
    if (!utxos.length) {
      empty += 1;
      continue;
    }
    empty = 0;
    for (const u of utxos)
      out.push({ txid: u.txid, vout: u.vout, satoshis: u.satoshis, address, index: i });
  }
  return out;
}

/** Broadcast a client-signed raw transaction; resolves to txid. */
async function broadcast(rawHex) {
  if (typeof rawHex !== 'string' || !/^[0-9a-fA-F]+$/.test(rawHex)) {
    throw new ServiceError('Invalid transaction hex', 400);
  }
  try {
    return await provider.broadcast(rawHex);
  } catch (e) {
    throw new ServiceError(`Broadcast failed: ${e.message}`, 502);
  }
}

/**
 * Resolve a recipient to a destination the CLIENT will pay: { address } or { script }.
 * External paymail is resolved server-side (avoids browser CORS to arbitrary hosts).
 */
async function resolveRecipient(to, { satoshis, senderPaymail } = {}) {
  to = String(to || '').trim();
  if (/^[^@\s]+@[^@\s]+$/.test(to)) {
    const [alias, domain] = to.split('@');
    if (domain.toLowerCase() === config.domain.toLowerCase()) {
      const u = await db.findByAlias(alias.toLowerCase());
      if (!u) throw new ServiceError(`Unknown paymail ${to}`, 404);
      return { address: depositAddress(u) };
    }
    try {
      const script = await paymailClient.getOutputScript(to, {
        satoshis,
        senderHandle: senderPaymail,
        purpose: 'web3keys payment',
      });
      return { script };
    } catch (e) {
      throw new ServiceError(`Could not resolve paymail ${to}: ${e.message}`, 422);
    }
  }
  try {
    bsv.Address.fromString(to);
  } catch {
    throw new ServiceError('Invalid recipient address', 400);
  }
  return { address: to };
}

module.exports = {
  provider,
  ServiceError,
  register,
  verifyRegistration,
  authenticate,
  getBalance,
  getSpendableUtxos,
  broadcast,
  listOrdinals,
  resolveRecipient,
  publicProfile,
  depositAddress,
  receiveAddress,
  rotateReceiveAddress,
  issueOtp,
};
