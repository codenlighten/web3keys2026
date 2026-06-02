'use strict';

// Load .env (if present) without overriding vars already set in the environment.
// In production, env comes from systemd's EnvironmentFile; dotenv is a dev convenience.
try {
  require('dotenv').config({ quiet: true });
} catch {
  /* dotenv optional */
}

const crypto = require('crypto');
const { z } = require('zod');

/**
 * Central configuration, all driven by environment variables. Sensible dev defaults
 * are provided so the server runs locally without a .env, but production MUST set
 * JWT_SECRET and SMTP_* (see .env.example). The assembled config is validated with
 * zod so misconfiguration fails fast and loudly at startup.
 */
const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),

  // Public domain used for paymail handles (user@domain) and TLS.
  domain: process.env.WALLET_DOMAIN || 'web3keys.com',
  // Base URL the API is reachable at (used in paymail capability documents).
  baseUrl: process.env.BASE_URL || `https://${process.env.WALLET_DOMAIN || 'web3keys.com'}`,

  network: process.env.BSV_NETWORK || 'livenet',

  // Postgres connection string. If unset, the server falls back to an in-memory
  // Postgres (pg-mem) — used for tests/local; production MUST set DATABASE_URL.
  databaseUrl: process.env.DATABASE_URL || '',

  // Redis connection string for sessions, shared rate-limiting, cache, and the job
  // queue. If unset, the server falls back to in-memory equivalents (single-node only).
  redisUrl: process.env.REDIS_URL || '',

  // Session signing. In production this MUST be set; a random ephemeral secret in dev
  // means tokens are invalidated on restart (acceptable for local work).
  jwtSecret: process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex'),
  sessionTtlMs: Number(process.env.SESSION_TTL_MS || 30 * 60 * 1000), // 30 min

  // Master key (kept in the systemd secrets file, NOT the database) used to encrypt the
  // TTP-bound share (S3) at rest. REQUIRED in production. In dev/test a stable key is
  // derived so the server runs without extra setup.
  shareMasterKey:
    process.env.SHARE_MASTER_KEY ||
    (process.env.NODE_ENV === 'production'
      ? ''
      : crypto.createHash('sha256').update('web3keys-dev-share-master').digest('hex')),

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

const configSchema = z.object({
  env: z.enum(['development', 'test', 'production']),
  port: z.number().int().positive(),
  domain: z.string().min(1),
  baseUrl: z.string().url(),
  network: z.enum(['livenet', 'testnet']),
  databaseUrl: z.string(),
  redisUrl: z.string(),
  jwtSecret: z.string().min(16),
  shareMasterKey: z.string(),
  sessionTtlMs: z.number().int().positive(),
  otpTtlMs: z.number().int().positive(),
  otpLength: z.number().int().min(4).max(10),
  scrypt: z.object({ N: z.number(), r: z.number(), p: z.number(), keylen: z.number() }),
  smtp: z.object({
    host: z.string().optional(),
    port: z.number().int().positive(),
    secure: z.boolean(),
    user: z.string().optional(),
    pass: z.string().optional(),
    from: z.string().min(1),
  }),
});

const parsed = configSchema.safeParse(config);
if (!parsed.success) {
  throw new Error(
    `Invalid configuration:\n${parsed.error.issues.map((i) => ` - ${i.path.join('.')}: ${i.message}`).join('\n')}`
  );
}

config.isProd = config.env === 'production';

/** Fail fast in production if critical secrets are missing. */
function assertProductionConfig() {
  if (!config.isProd) return;
  const missing = [];
  if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
  if (!config.shareMasterKey) missing.push('SHARE_MASTER_KEY');
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (!config.redisUrl) missing.push('REDIS_URL');
  if (!config.smtp.host || !config.smtp.user || !config.smtp.pass)
    missing.push('SMTP_HOST/SMTP_USER/SMTP_PASS(WORD)');
  if (missing.length) {
    throw new Error(`Missing required production config: ${missing.join(', ')}`);
  }
}

module.exports = { config, assertProductionConfig };
