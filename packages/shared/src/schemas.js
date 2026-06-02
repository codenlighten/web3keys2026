'use strict';

const { z } = require('zod');

/**
 * Request validation schemas shared by the server (and, later, the web client).
 * Keep these strict — they are the first line of input validation on every route.
 */

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(8).max(200);
const otpCode = z.string().regex(/^\d{6}$/, 'code must be 6 digits');

const schemas = {
  register: z.object({ email, password }),
  login: z.object({ email, password, totpCode: z.string().optional() }),
  verify: z.object({ email, code: otpCode }),
  resend: z.object({ email }),
  recover: z.object({
    email,
    recoveryShare: z.string().min(1).max(4096),
    newPassword: password,
  }),
  send: z.object({
    to: z.string().min(1).max(512),
    satoshis: z.number().int().positive().max(2.1e15),
  }),
  twoFactorEnable: z.object({ code: otpCode }),
  twoFactorDisable: z.object({ code: otpCode }),
};

module.exports = { schemas };
