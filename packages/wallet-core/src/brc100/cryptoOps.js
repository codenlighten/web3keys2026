'use strict';

const nodeCrypto = require('crypto');
const bsv = require('@smartledger/bsv');
const { crypto } = bsv;
const { ECDSA, Hash, Signature } = crypto;

/**
 * BRC-100 cryptographic operations, all keyed through a KeyDeriver so every
 * operation is scoped to a (protocolID, keyID, counterparty) triple.
 *
 * - encrypt/decrypt: AES-256-GCM under the BRC-42 derived symmetric key
 * - createHmac/verifyHmac: HMAC-SHA256 under the derived symmetric key
 * - createSignature/verifySignature: ECDSA under the derived private/public key
 */
class CryptoOps {
  /** @param {import('./KeyDeriver').KeyDeriver} keyDeriver */
  constructor(keyDeriver) {
    this.kd = keyDeriver;
  }

  encrypt({ plaintext, protocolID, keyID, counterparty = 'self' }) {
    const key = this.kd.deriveSymmetricKey(protocolID, keyID, counterparty);
    const iv = nodeCrypto.randomBytes(12);
    const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
    const enc = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag = cipher.getAuthTag();
    // ciphertext layout: iv(12) || tag(16) || enc
    return Buffer.concat([iv, tag, enc]);
  }

  decrypt({ ciphertext, protocolID, keyID, counterparty = 'self' }) {
    const key = this.kd.deriveSymmetricKey(protocolID, keyID, counterparty);
    const buf = Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(ciphertext, 'hex');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]);
  }

  createHmac({ data, protocolID, keyID, counterparty = 'self' }) {
    const key = this.kd.deriveSymmetricKey(protocolID, keyID, counterparty);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    return Hash.sha256hmac(buf, Buffer.from(key));
  }

  verifyHmac({ data, hmac, protocolID, keyID, counterparty = 'self' }) {
    const expected = this.createHmac({ data, protocolID, keyID, counterparty });
    const got = Buffer.isBuffer(hmac) ? hmac : Buffer.from(hmac, 'hex');
    return expected.length === got.length && nodeCrypto.timingSafeEqual(expected, got);
  }

  createSignature({ data, protocolID, keyID, counterparty = 'self' }) {
    const priv = this.kd.derivePrivateKey(protocolID, keyID, counterparty);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const hashbuf = Hash.sha256(buf);
    const sig = ECDSA.sign(hashbuf, priv);
    return sig.toDER();
  }

  /**
   * Verify a signature. By default verifies a signature WE made (forSelf), i.e. the
   * verifier derives our public key. To verify a counterparty's signature, set
   * verifyingForCounterparty to that party's public key.
   */
  verifySignature({ data, signature, protocolID, keyID, counterparty = 'self', forSelf = true }) {
    const pub = this.kd.derivePublicKey(protocolID, keyID, counterparty, forSelf);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const hashbuf = Hash.sha256(buf);
    const der = Buffer.isBuffer(signature) ? signature : Buffer.from(signature, 'hex');
    return ECDSA.verify(hashbuf, Signature.fromDER(der), pub);
  }
}

module.exports = { CryptoOps };
