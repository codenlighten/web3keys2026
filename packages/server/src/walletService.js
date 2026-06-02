'use strict';

const { Wallet, WhatsOnChainProvider, bsv, threshold } = require('@web3keys/wallet-core');
const { config } = require('./config');
const db = require('./db');
const security = require('./security');
const shares = require('./shares');
const { ServiceError } = require('./errors');
const { sendOtpEmail } = require('./mailer');

/**
 * walletService: registration, OTP verification, login/unlock, and wallet operations.
 *
 * v1 address model: each user has a single deposit address = finance account index 0
 * (m/44'/0'/0'/0/0). This keeps balance/send provably correct against received funds.
 * Address rotation per paymail request is a planned enhancement (the receive_index
 * column and xpub storage already support it).
 */

const provider = new WhatsOnChainProvider({ network: config.network });

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

function net() {
  return provider.network === 'testnet' ? bsv.Networks.testnet : bsv.Networks.livenet;
}

/** Derive a receive address from the PUBLIC finance xpub at change 0 / index (no seed). */
function deriveFromXpub(xpub, index) {
  return bsv.HDPublicKey.fromString(xpub)
    .deriveChild(0)
    .deriveChild(index)
    .publicKey.toAddress(net())
    .toString();
}

/** Public deposit address for a stored user (default index 0). */
function depositAddress(user, index = 0) {
  return deriveFromXpub(user.finance_xpub, index);
}

/** The user's current rotating receive address (at their stored receive_index). */
function receiveAddress(user) {
  return deriveFromXpub(user.finance_xpub, user.receive_index || 0);
}

/**
 * Read-only balance by scanning addresses derived from the public finance xpub (gap
 * limit). Works without the seed — only the xpub is needed.
 */
async function scanXpubSatoshis(user, { gapLimit = 20, maxIndex = 500 } = {}) {
  let total = 0;
  let empty = 0;
  for (let i = 0; i <= maxIndex && empty < gapLimit; i++) {
    // eslint-disable-next-line no-await-in-loop
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

async function register({ email, password }) {
  email = String(email || '')
    .trim()
    .toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ServiceError('Invalid email');
  if (!password || String(password).length < 8) {
    throw new ServiceError('Password must be at least 8 characters');
  }
  if (await db.findByEmail(email)) throw new ServiceError('Email already registered', 409);

  // Generate the wallet and split its seed 2-of-3. The server stores only the two
  // service shares (S2 sealed under the password, S3 sealed under the master key) plus
  // public xpubs/identity key. S1 goes to the user as their recovery share.
  const wallet = Wallet.generate({ network: config.network });
  const split = threshold.splitSeed(wallet.mnemonic); // { user, service, ttp }
  const described = wallet.keyManager.describe();
  const alias = await uniqueAlias(email);

  const user = await db.createUser({
    email,
    alias,
    passwordVerifier: security.hashPassword(password),
    identityPubkey: wallet.identity.identityKey,
    financeXpub: described.finance.xpub,
    tokensXpub: described.tokens.xpub,
    identityXpub: described.identity.xpub,
    verified: false,
  });

  await db.putUserShare(user.id, shares.sealUserShare(split.service, password)); // S2
  await db.putTtpShare(user.id, shares.sealTtpShare(split.ttp)); // S3

  await issueOtp(email, 'register');

  // The recovery share (S1) is returned exactly once for the user to store off-box.
  // The full mnemonic is never returned here — it is available via the authenticated
  // /api/wallet/export escape hatch after login.
  return {
    recoveryShare: split.user,
    backupReminder:
      'Save this recovery share now — it is shown only once and lets you recover your wallet.',
    profile: publicProfile(user),
    otpSent: true,
  };
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
 * Authenticate and UNLOCK: verify the password, then reconstruct the seed from the two
 * service shares — S2 (opened with the password) + S3 (opened with the master key) —
 * and return a live Wallet plus the user row. Throws on bad credentials.
 *
 * The seed exists only transiently here, held in the session vault for signing. A DB
 * breach at rest cannot do this: S2 needs the password, S3 needs the (off-DB) master key.
 */
async function unlock({ email, password }) {
  email = String(email || '')
    .trim()
    .toLowerCase();
  const user = await db.findByEmail(email);
  if (!user) throw new ServiceError('Invalid credentials', 401);
  if (!user.verified) throw new ServiceError('Email not verified', 403);
  if (!security.verifyPassword(password, user.password_verifier)) {
    throw new ServiceError('Invalid credentials', 401);
  }

  const [us, ts] = await Promise.all([db.getUserShare(user.id), db.getTtpShare(user.id)]);
  if (!us || !ts) throw new ServiceError('Wallet shares missing', 500);

  let s2;
  try {
    s2 = shares.openUserShare(us, password); // password-gated service share
  } catch {
    throw new ServiceError('Invalid credentials', 401);
  }
  const s3 = shares.openTtpShare(ts); // master-key-gated TTP share
  const mnemonic = threshold.reconstruct([s2, s3]);
  const wallet = Wallet.fromMnemonic(mnemonic, { network: config.network, provider });
  return { user, wallet };
}

/**
 * Recover access using the user's recovery share (S1) when the password is lost.
 * Reconstructs from S1 + S3, then re-splits the seed (so a fresh recovery share is
 * issued and the old one is consumed) and re-seals S2 under the new password. The seed
 * and wallet addresses are unchanged.
 */
async function recover({ email, recoveryShare, newPassword }) {
  email = String(email || '')
    .trim()
    .toLowerCase();
  if (!newPassword || String(newPassword).length < 8) {
    throw new ServiceError('Password must be at least 8 characters');
  }
  const user = await db.findByEmail(email);
  if (!user) throw new ServiceError('Recovery failed', 401);
  const ts = await db.getTtpShare(user.id);
  if (!ts) throw new ServiceError('Wallet shares missing', 500);

  let mnemonic;
  try {
    mnemonic = threshold.reconstruct([recoveryShare, shares.openTtpShare(ts)]);
  } catch {
    throw new ServiceError('Invalid recovery share', 400);
  }

  // Re-split so the consumed recovery share is replaced and S2 is re-sealed under the
  // new password (addresses are derived from the unchanged seed, so they don't move).
  const fresh = threshold.splitSeed(mnemonic);
  await db.putUserShare(user.id, shares.sealUserShare(fresh.service, newPassword));
  await db.putTtpShare(user.id, shares.sealTtpShare(fresh.ttp));
  await db.setPassword(email, security.hashPassword(newPassword));

  return { recoveryShare: fresh.user, profile: publicProfile(user) };
}

async function getBalance(user) {
  const confirmed = await scanXpubSatoshis(user);
  return { confirmed, unconfirmed: 0 };
}

/** Advance the user's rotating receive address and return the new one. */
async function rotateReceiveAddress(user) {
  const index = await db.bumpReceiveIndex(user.email);
  return { address: deriveFromXpub(user.finance_xpub, index), index };
}

/**
 * Resolve a recipient (raw address or paymail handle) to a destination address.
 * Local paymail (user@thisdomain) resolves from the DB; external paymail is not yet
 * supported in v1.
 */
async function resolveRecipient(to) {
  to = String(to || '').trim();
  if (/^[^@\s]+@[^@\s]+$/.test(to)) {
    const [alias, domain] = to.split('@');
    if (domain.toLowerCase() !== config.domain.toLowerCase()) {
      throw new ServiceError(
        'External paymail resolution is not supported yet; use an address',
        422
      );
    }
    const u = await db.findByAlias(alias.toLowerCase());
    if (!u) throw new ServiceError(`Unknown paymail ${to}`, 404);
    return depositAddress(u);
  }
  try {
    bsv.Address.fromString(to); // validate
  } catch {
    throw new ServiceError('Invalid recipient address', 400);
  }
  return to;
}

/**
 * Send BSV from an unlocked session wallet, gathering UTXOs across ALL the finance
 * account's funded addresses (not just index 0). amount in satoshis.
 */
async function send(wallet, { to, satoshis }) {
  const address = await resolveRecipient(to);
  const amt = Number(satoshis);
  if (!Number.isInteger(amt) || amt <= 0) throw new ServiceError('Invalid amount', 400);
  const result = await wallet.sendFromAccount([{ to: address, satoshis: amt }], {
    account: 'finance',
  });
  return { txid: result.broadcastTxid || result.txid, fee: result.fee, to: address, satoshis: amt };
}

module.exports = {
  provider,
  ServiceError,
  register,
  verifyRegistration,
  unlock,
  recover,
  getBalance,
  send,
  publicProfile,
  depositAddress,
  receiveAddress,
  rotateReceiveAddress,
  resolveRecipient,
  issueOtp,
};
