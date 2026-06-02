'use strict';

const { z } = require('zod');

/**
 * Request validation schemas shared by the server (and web client). Non-custodial:
 * registration carries only PUBLIC key material (identity key + xpubs), never a seed.
 */

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(8).max(200);
const otpCode = z.string().regex(/^\d{6}$/, 'code must be 6 digits');
const hexId = z.string().regex(/^[0-9a-fA-F]{64}$/);

const schemas = {
  register: z.object({
    email,
    password,
    identityKey: z.string().min(1).max(200),
    financeXpub: z.string().min(1).max(256),
    tokensXpub: z.string().min(1).max(256),
    identityXpub: z.string().min(1).max(256),
  }),
  login: z.object({ email, password, totpCode: z.string().optional() }),
  verify: z.object({ email, code: otpCode }),
  resend: z.object({ email }),
  broadcast: z.object({
    rawHex: z
      .string()
      .regex(/^[0-9a-fA-F]+$/, 'hex')
      .max(2_000_000),
    to: z.string().max(512).optional(),
    satoshis: z.number().int().nonnegative().max(2.1e15).optional(),
  }),
  paymailResolve: z.object({
    to: z.string().min(1).max(512),
    satoshis: z.number().int().positive().max(2.1e15).optional(),
  }),
  backupPut: z.object({
    scheme: z.string().min(1).max(64),
    ciphertext: z.string().min(1).max(100_000),
  }),
  twoFactorEnable: z.object({ code: otpCode }),
  twoFactorDisable: z.object({ code: otpCode }),
  deleteAccount: z.object({ password }),
  // SmartLedger Login (sl-login.js) third-party SSO endpoints.
  ssoVerifyLogin: z.object({
    address: z.string().min(1).max(128),
    signature: z.string().min(1).max(200),
    challenge: z.string().min(1).max(128),
    domain: z.string().min(1).max(253),
  }),
  ssoCheckSession: z.object({
    token: z.string().min(1).max(128),
    domain: z.string().max(253).optional(),
  }),
  ssoRevokeSession: z.object({
    token: z.string().min(1).max(128),
    domain: z.string().max(253).optional(),
  }),
  ssoVerifyAttest: z.object({
    address: z.string().min(1).max(128),
    signature: z.string().min(1).max(200),
    payload: z.string().min(1).max(4096),
    app: z.string().max(128).optional(),
    domain: z.string().min(1).max(253),
    nonce: z.string().min(1).max(128),
  }),
  ordinalTxid: z.object({ txid: hexId, vout: z.number().int().min(0) }),
};

module.exports = { schemas };
