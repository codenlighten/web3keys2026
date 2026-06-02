'use strict';

const bsv = require('@smartledger/bsv');
const { PrivateKey, PublicKey, crypto } = bsv;
const { BN, Point, Hash } = crypto;

const N = Point.getN(); // secp256k1 curve order
const G = Point.getG();

/**
 * BRC-42 / BRC-43 key derivation, implemented on @smartledger/bsv EC primitives.
 *
 * BRC-42 (BSV Key Derivation Scheme):
 *   Given our key pair (a, A) and a counterparty public key B, and an invoice
 *   number string, the shared secret is S = a·B (compressed point). A scalar
 *   c = HMAC-SHA256(S, invoiceNumber) is then used to derive:
 *     child private key  b' = (a + c) mod n
 *     child public  key  B' = B + c·G    (counterparty's, from our perspective)
 *
 * BRC-43 invoice number format: `${securityLevel}-${protocolName}-${keyID}`.
 */

/** Compressed serialization (33 bytes) of an EC point. */
function pointToCompressed(point) {
  return PublicKey.fromPoint(point, true).toBuffer();
}

/** ECDH shared secret point between our private scalar and a counterparty point. */
function sharedSecretPoint(privBN, counterpartyPoint) {
  return counterpartyPoint.mul(privBN);
}

/** Scalar c from invoice number, keyed by the shared secret. */
function deriveScalar(sharedPoint, invoiceNumber) {
  const hmac = Hash.sha256hmac(Buffer.from(invoiceNumber, 'utf8'), pointToCompressed(sharedPoint));
  return new BN(hmac).umod(N);
}

/** Normalize a BRC-43 protocol ID into [securityLevel, protocolName]. */
function normalizeProtocol(protocolID) {
  let level;
  let name;
  if (Array.isArray(protocolID)) {
    [level, name] = protocolID;
  } else if (typeof protocolID === 'object' && protocolID) {
    level = protocolID.securityLevel;
    name = protocolID.protocol;
  } else {
    level = 2;
    name = protocolID;
  }
  level = Number(level);
  if (![0, 1, 2].includes(level)) throw new Error(`Invalid security level: ${level}`);
  name = String(name).toLowerCase().trim();
  if (!name) throw new Error('Protocol name required');
  if (name.length > 280) throw new Error('Protocol name too long');
  if (!/^[a-z0-9 ]+$/.test(name)) throw new Error('Protocol name has invalid characters');
  return [level, name];
}

function computeInvoiceNumber(protocolID, keyID) {
  const [level, name] = normalizeProtocol(protocolID);
  const kid = String(keyID);
  if (!kid || kid.length > 800) throw new Error('Invalid keyID');
  return `${level}-${name}-${kid}`;
}

const ANYONE = new PrivateKey(new BN(1), bsv.Networks.livenet);

class KeyDeriver {
  /** @param {PrivateKey} rootKey  the identity root private key */
  constructor(rootKey) {
    this.rootKey = rootKey instanceof PrivateKey ? rootKey : new PrivateKey(rootKey);
    this.identityKey = this.rootKey.publicKey;
  }

  /** Resolve a counterparty spec into a PublicKey. */
  normalizeCounterparty(counterparty) {
    if (counterparty === 'self' || counterparty === undefined || counterparty === null) {
      return this.identityKey;
    }
    if (counterparty === 'anyone') {
      return ANYONE.publicKey;
    }
    if (counterparty instanceof PublicKey) return counterparty;
    return PublicKey.fromString(String(counterparty));
  }

  /** Our derived child PRIVATE key for (protocol, keyID, counterparty). */
  derivePrivateKey(protocolID, keyID, counterparty = 'self') {
    const cp = this.normalizeCounterparty(counterparty);
    const invoice = computeInvoiceNumber(protocolID, keyID);
    const S = sharedSecretPoint(this.rootKey.bn, cp.point);
    const c = deriveScalar(S, invoice);
    const childBN = this.rootKey.bn.add(c).umod(N);
    return new PrivateKey(childBN, this.rootKey.network);
  }

  /**
   * A derived child PUBLIC key.
   * @param {boolean} forSelf  true → public key of OUR derived private key (what the
   *                           counterparty would compute for us). false → the
   *                           counterparty's derived public key from our perspective.
   */
  derivePublicKey(protocolID, keyID, counterparty = 'self', forSelf = false) {
    if (forSelf) {
      return this.derivePrivateKey(protocolID, keyID, counterparty).publicKey;
    }
    const cp = this.normalizeCounterparty(counterparty);
    const invoice = computeInvoiceNumber(protocolID, keyID);
    const S = sharedSecretPoint(this.rootKey.bn, cp.point);
    const c = deriveScalar(S, invoice);
    const childPoint = cp.point.add(G.mul(c));
    return PublicKey.fromPoint(childPoint, true);
  }

  /**
   * A 32-byte symmetric key shared between us and a counterparty for (protocol, keyID).
   * Not derivable for the 'anyone' counterparty.
   */
  deriveSymmetricKey(protocolID, keyID, counterparty = 'self') {
    if (counterparty === 'anyone') {
      throw new Error('Cannot derive a symmetric key for the "anyone" counterparty');
    }
    const priv = this.derivePrivateKey(protocolID, keyID, counterparty);
    const pub = this.derivePublicKey(protocolID, keyID, counterparty, false);
    const S = sharedSecretPoint(priv.bn, pub.point);
    return pointToCompressed(S).slice(1); // 32-byte x coordinate
  }
}

module.exports = {
  KeyDeriver,
  normalizeProtocol,
  computeInvoiceNumber,
  pointToCompressed,
};
