'use strict';

const crypto = require('crypto');
const { config } = require('./config');

/**
 * Security primitives for the wallet service.
 *
 * Two independent password-derived values, with separate salts (domain separation):
 *   - a password VERIFIER (to authenticate login)            -> hashPassword/verifyPassword
 *   - a mnemonic ENCRYPTION KEY (to seal the seed at rest)   -> encryptMnemonic/decryptMnemonic
 *
 * The server therefore stores only: the verifier, and the AES-GCM-sealed mnemonic.
 * Neither yields the mnemonic without the user's password. The seed is decrypted only
 * transiently, inside an authenticated session, for signing operations.
 */

const { N, r, p, keylen } = config.scrypt;

function scrypt(password, salt) {
  return crypto.scryptSync(Buffer.from(password, 'utf8'), salt, keylen, {
    N,
    r,
    p,
    maxmem: 256 * 1024 * 1024,
  });
}

// ── password verifier ──────────────────────────────────────────────────────────

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = scrypt(password, salt);
  return `scrypt$${N}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, , saltHex, hashHex] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scrypt(password, salt);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ── mnemonic encryption (AES-256-GCM, password-derived key) ──────────────────────

function encryptMnemonic(mnemonic, password) {
  const encSalt = crypto.randomBytes(16);
  const key = scrypt(password, encSalt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(mnemonic, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encSalt: encSalt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: ct.toString('hex'),
  };
}

function decryptMnemonic(sealed, password) {
  const key = scrypt(password, Buffer.from(sealed.encSalt, 'hex'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'hex'));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'hex')),
    decipher.final(),
  ]);
  return pt.toString('utf8'); // throws (bad auth tag) on wrong password
}

// ── OTP ──────────────────────────────────────────────────────────────────────

function generateOtp() {
  // numeric OTP of config.otpLength digits, uniformly random
  const max = 10 ** config.otpLength;
  const n = crypto.randomInt(0, max);
  return String(n).padStart(config.otpLength, '0');
}

function hashOtp(otp) {
  return crypto.createHmac('sha256', config.jwtSecret).update(otp).digest('hex');
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = {
  hashPassword,
  verifyPassword,
  encryptMnemonic,
  decryptMnemonic,
  generateOtp,
  hashOtp,
  randomToken,
};
