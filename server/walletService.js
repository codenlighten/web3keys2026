'use strict';

const bsv = require('@smartledger/bsv');
const { Wallet, WhatsOnChainProvider } = require('../src');
const { config } = require('./config');
const db = require('./db');
const security = require('./security');
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

class ServiceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function sanitizeAlias(email) {
  return email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 32) || 'user';
}

function uniqueAlias(email) {
  const base = sanitizeAlias(email);
  let alias = base;
  let n = 0;
  while (db.findByAlias(alias)) {
    n += 1;
    alias = `${base}${n}`;
  }
  return alias;
}

/** Public deposit address for a stored user (derived from the public finance xpub). */
function depositAddress(user) {
  const hpub = bsv.HDPublicKey.fromString(user.finance_xpub);
  return hpub.deriveChild(0).deriveChild(0).publicKey.toAddress(provider.network === 'testnet' ? bsv.Networks.testnet : bsv.Networks.livenet).toString();
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
  db.upsertOtp({
    email,
    purpose,
    codeHash: security.hashOtp(code),
    expiresAt: Date.now() + config.otpTtlMs,
  });
  await sendOtpEmail(email, code, purpose);
}

async function register({ email, password }) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ServiceError('Invalid email');
  if (!password || String(password).length < 8) {
    throw new ServiceError('Password must be at least 8 characters');
  }
  if (db.findByEmail(email)) throw new ServiceError('Email already registered', 409);

  // Generate the wallet and seal its mnemonic with the user's password.
  const wallet = Wallet.generate({ network: config.network });
  const mnemonic = wallet.mnemonic;
  const sealed = security.encryptMnemonic(mnemonic, password);
  const described = wallet.keyManager.describe();

  const alias = uniqueAlias(email);
  db.createUser({
    email,
    alias,
    passwordVerifier: security.hashPassword(password),
    sealed,
    identityPubkey: wallet.identity.identityKey,
    financeXpub: described.finance.xpub,
    tokensXpub: described.tokens.xpub,
    identityXpub: described.identity.xpub,
    verified: false,
    createdAt: isoNow(),
  });

  await issueOtp(email, 'register');

  const user = db.findByEmail(email);
  // The mnemonic is returned exactly once, here, for the user to back up. Never stored
  // or logged in plaintext, and never returned again.
  return {
    mnemonic,
    backupReminder: 'Write down or copy these 12 words now. They are shown only once.',
    profile: publicProfile(user),
    otpSent: true,
  };
}

function verifyRegistration({ email, code }) {
  email = String(email || '').trim().toLowerCase();
  const otp = db.getOtp(email, 'register');
  if (!otp) throw new ServiceError('No pending verification', 404);
  if (Date.now() > otp.expires_at) {
    db.deleteOtp(email, 'register');
    throw new ServiceError('Code expired', 410);
  }
  if (otp.attempts >= 5) {
    db.deleteOtp(email, 'register');
    throw new ServiceError('Too many attempts', 429);
  }
  if (security.hashOtp(String(code)) !== otp.code_hash) {
    db.incrementOtpAttempts(email, 'register');
    throw new ServiceError('Invalid code', 401);
  }
  db.setVerified(email);
  db.deleteOtp(email, 'register');
  return publicProfile(db.findByEmail(email));
}

/**
 * Authenticate and UNLOCK: verifies the password, decrypts the mnemonic, and returns a
 * live Wallet instance (with provider) plus the user row. Throws on bad credentials.
 */
function unlock({ email, password }) {
  email = String(email || '').trim().toLowerCase();
  const user = db.findByEmail(email);
  if (!user) throw new ServiceError('Invalid credentials', 401);
  if (!user.verified) throw new ServiceError('Email not verified', 403);
  if (!security.verifyPassword(password, user.password_verifier)) {
    throw new ServiceError('Invalid credentials', 401);
  }
  let mnemonic;
  try {
    mnemonic = security.decryptMnemonic(
      { encSalt: user.enc_salt, iv: user.enc_iv, tag: user.enc_tag, ciphertext: user.enc_ciphertext },
      password
    );
  } catch {
    throw new ServiceError('Invalid credentials', 401);
  }
  const wallet = Wallet.fromMnemonic(mnemonic, { network: config.network, provider });
  return { user, wallet };
}

async function getBalance(user) {
  return provider.getBalance(depositAddress(user));
}

/**
 * Resolve a recipient (raw address or paymail handle) to a destination address.
 * Local paymail (user@thisdomain) resolves from the DB; external paymail is not yet
 * supported in v1.
 */
function resolveRecipient(to) {
  to = String(to || '').trim();
  if (/^[^@\s]+@[^@\s]+$/.test(to)) {
    const [alias, domain] = to.split('@');
    if (domain.toLowerCase() !== config.domain.toLowerCase()) {
      throw new ServiceError('External paymail resolution is not supported yet; use an address', 422);
    }
    const u = db.findByAlias(alias.toLowerCase());
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

/** Send BSV from an unlocked session wallet. amount in satoshis. */
async function send(wallet, { to, satoshis }) {
  const address = resolveRecipient(to);
  const amt = Number(satoshis);
  if (!Number.isInteger(amt) || amt <= 0) throw new ServiceError('Invalid amount', 400);
  const result = await wallet.send([{ to: address, satoshis: amt }]);
  return { txid: result.broadcastTxid || result.txid, fee: result.fee, to: address, satoshis: amt };
}

function isoNow() {
  // ISO timestamp; isolated so it's easy to stub in tests.
  return new Date().toISOString();
}

module.exports = {
  provider,
  ServiceError,
  register,
  verifyRegistration,
  unlock,
  getBalance,
  send,
  publicProfile,
  depositAddress,
  resolveRecipient,
  issueOtp,
};
