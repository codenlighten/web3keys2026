'use strict';

const { authenticator } = require('otplib');
const db = require('./db');
const shares = require('./shares');
const { config } = require('./config');
const { ServiceError } = require('./errors');

/**
 * TOTP two-factor auth. The secret is sealed under the server master key (never stored
 * plaintext) and 2FA is only enforced after the user confirms enrollment with a code.
 */

// Allow ±1 step (30s) of clock drift.
authenticator.options = { window: 1 };

/** Begin enrollment: generate + store a (not-yet-enabled) secret, return provisioning data. */
async function setup(user) {
  const secret = authenticator.generateSecret();
  await db.setTotp(user.email, shares.sealMaster(secret), false);
  const otpauth = authenticator.keyuri(user.email, config.domain, secret);
  return { secret, otpauth };
}

function openSecret(user) {
  if (!user.totp_enc) throw new ServiceError('2FA not set up', 400);
  return shares.openMaster(user.totp_enc);
}

/** Confirm enrollment by verifying a code, then enable enforcement. */
async function enable(user, code) {
  const secret = openSecret(user);
  if (!authenticator.verify({ token: String(code), secret })) {
    throw new ServiceError('Invalid 2FA code', 401);
  }
  await db.setTotp(user.email, user.totp_enc, true);
  return { enabled: true };
}

/** Disable 2FA (requires a valid current code). */
async function disable(user, code) {
  const secret = openSecret(user);
  if (!authenticator.verify({ token: String(code), secret })) {
    throw new ServiceError('Invalid 2FA code', 401);
  }
  await db.setTotp(user.email, null, false);
  return { enabled: false };
}

/** Enforce at login: throws if 2FA is enabled and the code is missing/invalid. */
function verifyLogin(user, code) {
  if (!user.totp_enabled) return;
  if (!code) throw new ServiceError('2FA code required', 401, { twoFactorRequired: true });
  const secret = shares.openMaster(user.totp_enc);
  if (!authenticator.verify({ token: String(code), secret })) {
    throw new ServiceError('Invalid 2FA code', 401);
  }
}

module.exports = { setup, enable, disable, verifyLogin };
