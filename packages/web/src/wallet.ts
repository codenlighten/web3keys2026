// Client-side wallet crypto — runs entirely in the browser via the @smartledger/bsv CDN
// bundle (window.bsv). Keys are generated and used here and NEVER sent to the server.
// Derivation paths match @web3keys/wallet-core: identity m/44'/236'/0', finance
// m/44'/0'/0', tokens m/44'/236'/2'.

/* eslint-disable @typescript-eslint/no-explicit-any */
function bsv(): any {
  const b = (window as any).bsv;
  if (!b || !b.Mnemonic) throw new Error('bsv library not loaded');
  return b;
}

export type Utxo = {
  txid: string;
  vout: number;
  satoshis: number;
  script: string;
  index: number;
};

export type Accounts = {
  identityKey: string;
  identityXpub: string;
  financeXpub: string;
  tokensXpub: string;
  financeAddress: string;
};

/** Generate a 24-word (256-bit) recovery phrase. */
export function generateMnemonic(): string {
  return new (bsv().Mnemonic)(256).toString();
}

export function validateMnemonic(m: string): boolean {
  try {
    return !!bsv().Mnemonic.isValid(m.trim());
  } catch {
    return false;
  }
}

// An optional BIP-39 passphrase ("25th word") salts the seed — same phrase + different
// passphrase = a different wallet. It is part of the secret and never sent to the server.
function master(mnemonic: string, passphrase = ''): any {
  return bsv().Mnemonic.fromString(mnemonic.trim()).toHDPrivateKey(passphrase);
}

/** Public material the server stores at registration — no seed. */
export function deriveAccounts(mnemonic: string, passphrase = ''): Accounts {
  const m = master(mnemonic, passphrase);
  return {
    identityKey: m.deriveChild("m/44'/236'/0'/0/0").privateKey.publicKey.toString(),
    identityXpub: m.deriveChild("m/44'/236'/0'").hdPublicKey.toString(),
    financeXpub: m.deriveChild("m/44'/0'/0'").hdPublicKey.toString(),
    tokensXpub: m.deriveChild("m/44'/236'/2'").hdPublicKey.toString(),
    financeAddress: m.deriveChild("m/44'/0'/0'/0/0").privateKey.toAddress().toString(),
  };
}

/** True if the mnemonic (+ optional passphrase) controls the finance deposit address. */
export function controlsAddress(mnemonic: string, passphrase: string, address: string): boolean {
  try {
    return deriveAccounts(mnemonic, passphrase).financeAddress === address;
  } catch {
    return false;
  }
}

/**
 * Build and sign a payment entirely client-side. Spends the provided finance UTXOs
 * (each derived at m/44'/0'/0'/0/index), pays `satoshis` to the destination
 * (address or locking script), and returns change to finance index 0. Returns raw tx hex.
 */
export function buildSignedTx(
  mnemonic: string,
  passphrase: string,
  utxos: Utxo[],
  dest: { address?: string; script?: string },
  satoshis: number
): string {
  const B = bsv();
  const m = master(mnemonic, passphrase);
  const tx = new B.Transaction();
  const keys: any[] = [];
  for (const u of utxos) {
    const priv = m.deriveChild(`m/44'/0'/0'/0/${u.index}`).privateKey;
    tx.from({ txId: u.txid, outputIndex: u.vout, script: u.script, satoshis: u.satoshis });
    keys.push(priv);
  }
  if (dest.script) {
    tx.addOutput(new B.Transaction.Output({ script: B.Script.fromHex(dest.script), satoshis }));
  } else {
    tx.to(dest.address, satoshis);
  }
  tx.change(m.deriveChild("m/44'/0'/0'/0/0").privateKey.toAddress());
  tx.feePerKb(50);
  tx.sign(keys);
  if (!tx.isFullySigned()) throw new Error('failed to fully sign transaction');
  return tx.uncheckedSerialize();
}

// ── SmartLedger Login (sl-login.js) — sign requests from third-party apps ────────────
// SSO requests are signed with the BAP root key (m/424150'/0'/0'/0/0/0, 424150 = the
// digits of hex"BAP"). This makes a web3keys identity a portable BAP identity: its bapId
// resolves to a profile on bap.network and is the SAME identity across any BAP-compatible
// wallet. The wallet's money accounts (finance m/44'/0'/0', tokens m/44'/236'/2') stay on
// their standard BIP-44 paths — identity and funds are deliberately separate key trees.
// No key material leaves the wallet — only the identity address/pubkey/bapId, a signature,
// and (if the user opts in) public receive addresses.

const BAP_ROOT_PATH = "m/424150'/0'/0'/0/0/0";

export type BapIdentity = { address: string; identityKey: string; bapId: string };

/** bapId = Base58(RIPEMD160(SHA256(asciiBytes(address)))) — matches SLProfile.resolve. */
function bapIdFromAddress(address: string): string {
  const B = bsv();
  const h1 = B.crypto.Hash.sha256(Buffer.from(address));
  const h2 = B.crypto.Hash.ripemd160(h1);
  return B.encoding.Base58(h2).toString();
}

/** The BAP identity private key plus its public address/key/bapId — the SSO signer. */
function bapIdentity(mnemonic: string, passphrase: string): { priv: any } & BapIdentity {
  const priv = master(mnemonic, passphrase).deriveChild(BAP_ROOT_PATH).privateKey;
  const address = priv.toAddress().toString();
  return {
    priv,
    address,
    identityKey: priv.publicKey.toString(),
    bapId: bapIdFromAddress(address),
  };
}

/** The user's public BAP identity (no signature) — for display / on-chain publish. */
export function identityInfo(mnemonic: string, passphrase: string): BapIdentity {
  const { address, identityKey, bapId } = bapIdentity(mnemonic, passphrase);
  return { address, identityKey, bapId };
}

/** Receive addresses the user may consent to share with an app (never private keys). */
export function scopeAddresses(
  mnemonic: string,
  passphrase: string
): { finAddress: string; ordAddress: string } {
  const m = master(mnemonic, passphrase);
  return {
    finAddress: m.deriveChild("m/44'/0'/0'/0/0").privateKey.toAddress().toString(),
    ordAddress: m.deriveChild("m/44'/236'/2'/0/0").privateKey.toAddress().toString(),
  };
}

/** Sign a sign-in challenge. `domain` is the requesting app's hostname. */
export function signLogin(
  mnemonic: string,
  passphrase: string,
  domain: string,
  challenge: string
): { address: string; signature: string; bapId: string; identityKey: string } {
  const { priv, address, bapId, identityKey } = bapIdentity(mnemonic, passphrase);
  const payload = `SmartLedger Wallet sign-in v1\nDomain: ${domain}\nNonce: ${challenge}`;
  return { address, signature: new (bsv().Message)(payload).sign(priv), bapId, identityKey };
}

/** Sign a structured attestation payload for an app. */
export function signAttest(
  mnemonic: string,
  passphrase: string,
  app: string,
  domain: string,
  nonce: string,
  payload: string
): { address: string; signature: string } {
  const { priv, address } = bapIdentity(mnemonic, passphrase);
  const msg = `SmartLedger Wallet attest v1\nApp: ${app}\nDomain: ${domain}\nNonce: ${nonce}\nPayload: ${payload}`;
  return { address, signature: new (bsv().Message)(msg).sign(priv) };
}

// BAP protocol prefixes for an on-chain identity record.
const BAP_PREFIX = '1BAPSuaPnfGnSBM3GLV9yhxUdYe4vGbdMT';
const AIP_PREFIX = '15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva';

/**
 * SELF-FUNDED BAP IDENTITY PUBLISH — SEAM (not auto-fired).
 *
 * Builds an OP_RETURN BAP `ID` record (prefix·ID·idKey·address·| + AIP BITCOIN_ECDSA
 * signature) funded by the user's finance UTXOs, so the identity becomes resolvable on
 * bap.network. The user spends their own sats (network fee only).
 *
 * NOTE: the exact on-chain field/AIP byte-scope must be QA'd against live bap.network
 * resolution before relying on it — this builds a structurally valid, AIP-self-consistent
 * tx, but resolution has not been verified end-to-end. Wire behind an explicit user action.
 */
export function buildBapIdTx(mnemonic: string, passphrase: string, utxos: Utxo[]): string {
  const B = bsv();
  const m = master(mnemonic, passphrase);
  const { priv, address, bapId } = bapIdentity(mnemonic, passphrase);

  // BAP ID payload fields, then the AIP separator. AIP signs everything up to and
  // including the separator (concatenated raw bytes).
  const head = [BAP_PREFIX, 'ID', bapId, address].map((s) => Buffer.from(s));
  const sep = Buffer.from('|');
  const signed = Buffer.concat([...head, sep]);
  const signature = new B.Message(signed).sign(priv); // BITCOIN_ECDSA over the head
  const aip = [AIP_PREFIX, 'BITCOIN_ECDSA', address, signature].map((s) => Buffer.from(s));

  const script = new B.Script().add(B.Opcode.OP_FALSE).add(B.Opcode.OP_RETURN);
  for (const f of [...head, sep, ...aip]) script.add(f);

  const tx = new B.Transaction();
  const keys: any[] = [];
  for (const u of utxos) {
    tx.from({ txId: u.txid, outputIndex: u.vout, script: u.script, satoshis: u.satoshis });
    keys.push(m.deriveChild(`m/44'/0'/0'/0/${u.index}`).privateKey);
  }
  tx.addOutput(new B.Transaction.Output({ script, satoshis: 0 }));
  tx.change(m.deriveChild("m/44'/0'/0'/0/0").privateKey.toAddress());
  tx.feePerKb(50);
  tx.sign(keys);
  if (!tx.isFullySigned()) throw new Error('failed to fully sign transaction');
  return tx.uncheckedSerialize();
}

export type PublishOutput = { fields: string[] };

/**
 * Build a self-funded OP_RETURN transaction client-side. Each output becomes an
 * `OP_FALSE OP_RETURN <push...>` data carrier funded by the user's finance UTXOs;
 * change returns to finance index 0. Returns raw tx hex for the server to broadcast.
 */
export function buildOpReturnTx(
  mnemonic: string,
  passphrase: string,
  utxos: Utxo[],
  outputs: PublishOutput[]
): string {
  const B = bsv();
  const m = master(mnemonic, passphrase);
  const tx = new B.Transaction();
  const keys: any[] = [];
  for (const u of utxos) {
    tx.from({ txId: u.txid, outputIndex: u.vout, script: u.script, satoshis: u.satoshis });
    keys.push(m.deriveChild(`m/44'/0'/0'/0/${u.index}`).privateKey);
  }
  for (const out of outputs) {
    const script = new B.Script().add(B.Opcode.OP_FALSE).add(B.Opcode.OP_RETURN);
    for (const hex of out.fields) script.add(Buffer.from(hex, 'hex'));
    tx.addOutput(new B.Transaction.Output({ script, satoshis: 0 }));
  }
  tx.change(m.deriveChild("m/44'/0'/0'/0/0").privateKey.toAddress());
  tx.feePerKb(50);
  tx.sign(keys);
  if (!tx.isFullySigned()) throw new Error('failed to fully sign transaction');
  return tx.uncheckedSerialize();
}

// ── Tier 1 encrypted backup (client-side; server stores only opaque ciphertext) ──────

const enc = new TextEncoder();
const dec = new TextDecoder();
// Web Crypto wants BufferSource; coerce around TS's typed-array generics.
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;
const b64 = (data: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...(data instanceof Uint8Array ? data : new Uint8Array(data))));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function keyFromPassphrase(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', bs(enc.encode(passphrase)), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: bs(salt), iterations: 210000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Encrypt the mnemonic under a passphrase (PBKDF2 + AES-GCM). Opaque to the server. */
export async function encryptBackup(mnemonic: string, passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFromPassphrase(passphrase, salt);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bs(iv) },
    key,
    bs(enc.encode(mnemonic))
  );
  return JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) });
}

export async function decryptBackup(ciphertext: string, passphrase: string): Promise<string> {
  const { salt, iv, ct } = JSON.parse(ciphertext);
  const key = await keyFromPassphrase(passphrase, unb64(salt));
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bs(unb64(iv)) },
    key,
    bs(unb64(ct))
  );
  return dec.decode(pt);
}
