'use strict';

const bsv = require('@smartledger/bsv');
const { Message, ECIES, PublicKey, Address } = bsv;

/**
 * Identity: message signing/verification and lightweight encryption rooted in the
 * wallet's identity key (m/44'/236'/0'/0/0). Used for app authentication, signed
 * attestations, and encrypted messaging between identities.
 */
class Identity {
  /** @param {import('../KeyManager').KeyManager} keyManager */
  constructor(keyManager) {
    this.keyManager = keyManager;
    this.privateKey = keyManager.privateKey('identity');
    this.publicKey = this.privateKey.publicKey;
  }

  get identityKey() {
    return this.publicKey.toString();
  }

  get address() {
    return this.privateKey.toAddress(this.keyManager.network).toString();
  }

  /** Sign a message (Bitcoin signed-message format). Returns base64 signature. */
  sign(message) {
    return new Message(String(message)).sign(this.privateKey);
  }

  /** Verify a Bitcoin signed message against an address (defaults to our own). */
  verify(message, signature, address = this.address) {
    try {
      return new Message(String(message)).verify(new Address(address), signature);
    } catch {
      return false;
    }
  }

  /** Encrypt a message to a recipient identity public key (ECIES). */
  encryptTo(recipientPubKey, message) {
    const pub = recipientPubKey instanceof PublicKey ? recipientPubKey : PublicKey.fromString(recipientPubKey);
    return ECIES().privateKey(this.privateKey).publicKey(pub).encrypt(String(message));
  }

  /** Decrypt a message sent to us from a sender's identity public key. */
  decryptFrom(senderPubKey, ciphertext) {
    const pub = senderPubKey instanceof PublicKey ? senderPubKey : PublicKey.fromString(senderPubKey);
    const buf = Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(ciphertext, 'hex');
    return ECIES().privateKey(this.privateKey).publicKey(pub).decrypt(buf).toString();
  }

  /**
   * A simple did:key-style identifier from the identity public key, plus the BSV
   * address. (The package also ships DIDWeb/createDID for did:web flows.)
   */
  did() {
    return {
      did: `did:bsv:${this.address}`,
      identityKey: this.identityKey,
      address: this.address,
    };
  }
}

module.exports = { Identity };
