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
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bs(iv) }, key, bs(enc.encode(mnemonic)));
  return JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) });
}

export async function decryptBackup(ciphertext: string, passphrase: string): Promise<string> {
  const { salt, iv, ct } = JSON.parse(ciphertext);
  const key = await keyFromPassphrase(passphrase, unb64(salt));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bs(unb64(iv)) }, key, bs(unb64(ct)));
  return dec.decode(pt);
}
