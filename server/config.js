'use strict';

// Load .env (if present) without overriding vars already set in the environment.
try {
  require('dotenv').config();
} catch {
  /* dotenv optional */
}

const crypto = require('crypto');

/**
 * Central configuration, all driven by environment variables. Sensible dev defaults
 * are provided so the server runs locally without a .env, but production MUST set
 * JWT_SECRET and SMTP_* (see .env.example).
 */
const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),

  // Public domain used for paymail handles (user@domain) and TLS.
  domain: process.env.WALLET_DOMAIN || 'web3keys.com',
  // Base URL the API is reachable at (used in paymail capability documents).
  baseUrl: process.env.BASE_URL || `https://${process.env.WALLET_DOMAIN || 'web3keys.com'}`,

  network: process.env.BSV_NETWORK || 'livenet',

  // SQLite database file.
  dbFile: process.env.DB_FILE || './data/web3keys.db',

  // Session signing. In production this MUST be set; a random ephemeral secret in dev
  // means tokens are invalidated on restart (acceptable for local work).
  jwtSecret: process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex'),
  sessionTtlMs: Number(process.env.SESSION_TTL_MS || 30 * 60 * 1000), // 30 min

  otpTtlMs: Number(process.env.OTP_TTL_MS || 10 * 60 * 1000), // 10 min
  otpLength: 6,

  // scrypt cost parameters (used for password verifier + mnemonic encryption key).
  scrypt: { N: 16384, r: 8, p: 1, keylen: 32 },

  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS || process.env.SMTP_PASSWORD,
    from: process.env.SMTP_FROM || 'web3keys <no-reply@web3keys.com>',
  },
};

config.isProd = config.env === 'production';

/** Fail fast in production if critical secrets are missing. */
function assertProductionConfig() {
  if (!config.isProd) return;
  const missing = [];
  if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
  if (!config.smtp.host || !config.smtp.user || !config.smtp.pass) missing.push('SMTP_HOST/SMTP_USER/SMTP_PASS(WORD)');
  if (missing.length) {
    throw new Error(`Missing required production config: ${missing.join(', ')}`);
  }
}

module.exports = { config, assertProductionConfig };
