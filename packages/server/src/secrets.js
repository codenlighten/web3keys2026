'use strict';

const crypto = require('crypto');
const security = require('./security');
const { config } = require('./config');

/**
 * Server-side secret sealing under a master key from the systemd secrets file (env
 * SECRETS_KEY). Used ONLY for server-owned secrets that are not customer keys — e.g. the
 * TOTP 2FA secret at rest. The server holds NO wallet key material in the non-custodial
 * model; this exists purely so a DB dump doesn't expose 2FA secrets.
 */
function key() {
  if (!config.secretsKey) throw new Error('SECRETS_KEY is not configured');
  return crypto.createHash('sha256').update(String(config.secretsKey)).digest();
}

/** Seal a string → JSON {iv,tag,ciphertext,v}. */
function seal(plaintext) {
  return JSON.stringify({ ...security.aesEncrypt(plaintext, key()), v: 1 });
}

function open(json) {
  return security.aesDecrypt(JSON.parse(json), key()).toString('utf8');
}

module.exports = { seal, open };
