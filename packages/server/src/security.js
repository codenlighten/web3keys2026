'use strict';

const crypto = require('crypto');
const { config } = require('./config');

/**
 * Security primitives for the wallet service: password verifier, scrypt KDF, generic
 * AES-256-GCM, and OTP. Threshold share sealing (S2 under the user's password, S3 under
 * the server master key) is built on these in shares.js.
 */

const { N, r, p, keylen } = config.scrypt;

/** Derive a 32-byte key from a password (or any string) and salt via scrypt. */
function scrypt(password, salt) {
  return crypto.scryptSync(Buffer.from(password, 'utf8'), salt, keylen, {
    N,
    r,
    p,
    maxmem: 256 * 1024 * 1024,
  });
}

// ── generic AES-256-GCM ─────────────────────────────────────────────────────────

/** Encrypt with a 32-byte key. Returns hex {iv, tag, ciphertext}. */
function aesEncrypt(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([
    cipher.update(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8')),
    cipher.final(),
  ]);
  return {
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext: ct.toString('hex'),
  };
}

/** Decrypt {iv, tag, ciphertext} (hex) with a 32-byte key. Throws on bad key/tamper. */
function aesDecrypt(sealed, key) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'hex')), decipher.final()]);
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
  scrypt,
  aesEncrypt,
  aesDecrypt,
  hashPassword,
  verifyPassword,
  generateOtp,
  hashOtp,
  randomToken,
};
