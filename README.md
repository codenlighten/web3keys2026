# web3keys2

A BSV HD wallet library built on [`@smartledger/bsv`](https://www.npmjs.com/package/@smartledger/bsv). It supports BSV payments, 1Sat Ordinals, and a full **BRC-100** wallet-to-application substrate (BRC-42/43 key derivation, certificates, baskets, actions).

## Accounts & derivation

Three HD accounts, deliberately split across coin types:

| Account  | Path                  | Purpose                                            |
|----------|-----------------------|----------------------------------------------------|
| identity | `m/44'/236'/0'/0/0`   | Identity key, message signing, DID, BRC-100 auth   |
| finance  | `m/44'/0'/0'/0/0`     | Spendable BSV funds (payments, change, fees)       |
| tokens   | `m/44'/236'/2'/0/0`   | 1Sat Ordinals, inscriptions, tokens                |

`236` is BSV's SLIP-44 coin type; `0` is the legacy Bitcoin coin type used historically for BSV funds.

## Install

```bash
npm install
```

Requires Node 18+ (global `fetch` for the WhatsOnChain provider).

## Quick start

```js
const { Wallet, WhatsOnChainProvider } = require('web3keys2');

// Create or restore
const wallet = Wallet.generate();                       // new random wallet
// const wallet = Wallet.fromMnemonic('abandon abandon ... about');

console.log(wallet.mnemonic);
console.log(wallet.addresses());        // { identity, finance, tokens }

// Attach a chain data source (pluggable)
wallet.setProvider(new WhatsOnChainProvider({ network: 'livenet' }));

// Balance & send
await wallet.getBalance('finance');
await wallet.send([{ to: '1Dest...', satoshis: 25000 }]);

// 1Sat Ordinals
const ins = await wallet.inscribe({ data: 'hello ordinal', contentType: 'text/plain' });
const ords = await wallet.listOrdinals();
await wallet.transferOrdinal({ ordinalUtxo: ords[0], toAddress: '1New...' });
```

## Identity (signing / messaging)

```js
const sig = wallet.identity.sign('authenticate me');
wallet.identity.verify('authenticate me', sig);          // true
wallet.identity.did();                                   // { did, identityKey, address }

const ct = wallet.identity.encryptTo(recipientPubKey, 'secret');   // ECIES
const pt = otherWallet.identity.decryptFrom(senderPubKey, ct);
```

## BRC-100

`wallet.brc100` implements the BRC-100 `WalletInterface`. Keys are derived per
`(protocolID, keyID, counterparty)` via BRC-42/43.

```js
const b = wallet.brc100;
const proto = [2, 'my app'];          // [securityLevel, protocolName]

await b.getPublicKey({ identityKey: true });
await b.getPublicKey({ protocolID: proto, keyID: '1', counterparty: 'self' });

// Encryption (AES-256-GCM under derived symmetric key)
const { ciphertext } = await b.encrypt({ plaintext: 'hi', protocolID: proto, keyID: '1' });
await b.decrypt({ ciphertext, protocolID: proto, keyID: '1' });

// Signatures / HMAC
const { signature } = await b.createSignature({ data: 'x', protocolID: proto, keyID: '2' });
await b.verifySignature({ data: 'x', signature, protocolID: proto, keyID: '2', forSelf: true });

// Actions (transactions)
await b.createAction({
  description: 'pay',
  outputs: [{ lockingScript: scriptHex, satoshis: 1000, basket: 'payments' }],
});
await b.listActions();
await b.listOutputs({ basket: 'payments' });

// Deferred / offline / multi-party signing — inputs are PINNED at create time.
const { reference, signableTransaction } = await b.createAction({
  outputs: [{ lockingScript: scriptHex, satoshis: 1000 }],
  options: { signAndProcess: false },
});
// signableTransaction = { reference, tx: <unsigned hex>, inputs: [...pinned...], fee, changeAddress }
// signAction rebuilds the IDENTICAL transaction from the pinned inputs — no UTXO
// re-fetch, no re-selection — even if the wallet's UTXO set has changed since.
await b.signAction({ reference });                       // re-derives the signing key
await b.signAction({ reference, privateKeys: [signerKey], options: { noSend: true } });

// Pending actions are persisted through WalletStorage (no private keys stored), so a
// create→sign session survives a restart when backed by a durable storage. A separate
// instance sharing the same storage + seed can complete the signature:
await b.listPendingActions();

// Certificates (BRC-103 style)
const { certificate } = await b.acquireCertificate({ type: 'KYC', certifier: '02..', fields: { name: 'Greg' } });
await b.proveCertificate({ certificate, fieldsToReveal: ['name'], verifier: '03..' });
```

### Supported BRC-100 methods

`isAuthenticated`, `waitForAuthentication`, `getNetwork`, `getVersion`, `getHeight`,
`getHeaderForHeight`, `getPublicKey`, `revealSpecificKeyLinkage`, `encrypt`, `decrypt`,
`createHmac`, `verifyHmac`, `createSignature`, `verifySignature`, `createAction`,
`signAction`, `abortAction`, `listPendingActions`, `internalizeAction`, `listActions`, `listOutputs`,
`relinquishOutput`, `acquireCertificate`, `listCertificates`, `proveCertificate`,
`relinquishCertificate`, `discoverByIdentityKey`, `discoverByAttributes`.

## Persistent storage (SQLite)

By default the wallet uses in-memory storage. For durability — so balances/baskets,
certificates, action history, and **deferred (pinned) pending actions** survive a
restart — pass a `SqliteStorage`. It's backed by the built-in `node:sqlite` module
(no native dependency; Node 18.19+/20.6+/22+).

```js
const { Wallet, SqliteStorage } = require('web3keys2');

const storage = new SqliteStorage('./wallet.db');   // or ':memory:'
const wallet = Wallet.fromMnemonic(mnemonic, { storage, provider });

// ... create a deferred action now ...
const { reference } = await wallet.brc100.createAction({
  outputs: [{ lockingScript, satoshis: 1000 }],
  options: { signAndProcess: false },
});

// ... later, in a brand-new process: reopen the same file + seed and complete it.
const wallet2 = Wallet.fromMnemonic(mnemonic, { storage: new SqliteStorage('./wallet.db') });
await wallet2.brc100.signAction({ reference });      // signing key re-derived; no key on disk
```

`SqliteStorage` is a drop-in for `MemoryStorage` (identical async surface). Private keys
are never written to the database — pending records store the funding *account*, and the
signing key is re-derived from the seed at sign time. `node:sqlite` is lazy-required, so
importing the package stays silent until you actually construct a `SqliteStorage`.

## Wallet service (server)

`server/` is a HandCash-style consumer wallet service that consumes this library:
email-OTP registration, encrypted server-side mnemonic custody, paymail, and a JSON API.

```bash
cp .env.example .env      # set JWT_SECRET + SMTP_* (and WALLET_DOMAIN)
npm start                 # node server/index.js
```

**Security model.** The mnemonic is sealed with AES-256-GCM under a key derived from
the user's password (scrypt); the server stores only ciphertext + the **public** account
xpubs and identity key. It therefore cannot decrypt the seed without the user's password,
yet can still derive receive addresses and serve paymail. The seed is decrypted only
transiently in an in-memory session vault (TTL, wiped on logout) for signing. The mnemonic
is returned to the client exactly once at registration (copy-to-clipboard) and never logged.

### API

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/auth/register` | – | create account, seal mnemonic, email OTP; returns mnemonic once |
| POST | `/api/auth/verify` | – | confirm email with OTP code |
| POST | `/api/auth/login` | – | unlock wallet, returns JWT |
| POST | `/api/auth/logout` | JWT | wipe session vault entry |
| GET | `/api/wallet/profile` | JWT | profile + paymail + address |
| GET | `/api/wallet/balance` | JWT | confirmed/unconfirmed balance |
| POST | `/api/wallet/send` | JWT | send BSV to address or local paymail |
| GET | `/.well-known/bsvalias` | – | paymail capability discovery |
| GET | `/api/paymail/id/{paymail}` | – | paymail PKI (identity pubkey) |
| POST | `/api/paymail/address/{paymail}` | – | paymail payment destination (P2PKH script) |

### Deployment (DigitalOcean + nginx + TLS)

```bash
# on the droplet, as root:
bash deploy/provision.sh          # installs Node 22, nginx, certbot; clones repo; systemd + nginx
# then create /etc/web3keys/web3keys.env (from .env.example), start, and issue TLS:
systemctl start web3keys
certbot --nginx -d web3keys.com -d www.web3keys.com --redirect
```

`deploy/deploy.sh` redeploys latest code on an already-provisioned box.
TLS requires the domain's A records to point at the droplet first.

### Backups

`deploy/web3keys-backup.sh` (run daily by `web3keys-backup.timer`) takes a WAL-safe
SQLite snapshot, integrity-checks it, optionally **encrypts it client-side with age**,
and optionally syncs it **off-site to DigitalOcean Spaces** (private ACL). Retention is
14 days, local and remote.

Encryption is asymmetric: the server holds only the age **public** recipient
(`BACKUP_AGE_RECIPIENT`) and cannot decrypt its own backups — the private identity lives
off-box. Generate it on a trusted machine (not the server):

```bash
age-keygen -o backup-identity.txt          # keep this file OFF the server
age-keygen -y backup-identity.txt          # prints the recipient -> BACKUP_AGE_RECIPIENT
```

Restore (needs the off-box identity):

```bash
# fetch a blob (from the droplet or Spaces), then:
age -d -i backup-identity.txt web3keys-<TS>.db.gz.age | gunzip > web3keys.db
install -o web3keys -g web3keys -m600 web3keys.db /var/lib/web3keys/web3keys.db
systemctl restart web3keys
```

If `BACKUP_AGE_RECIPIENT` is unset the blob is plain gzip; if `DO_SPACES_*` is unset it
stays local only.

## Pluggable providers

Implement `ChainProvider` to back the wallet with any data source (a node,
GorillaPool/1Sat for ordinals, a mock for tests). `WhatsOnChainProvider` ships by default.

```js
const { ChainProvider } = require('web3keys2');
class MyProvider extends ChainProvider { /* getBalance, getUtxos, broadcast, ... */ }
```

## CLI

```bash
node bin/cli.js new
node bin/cli.js info        --mnemonic "..."
node bin/cli.js sign        --mnemonic "..." --message "hi"
node bin/cli.js balance     --mnemonic "..." --account finance
node bin/cli.js derive-pub  --mnemonic "..." --protocol "message signing" --keyid 1
```

## Tests

```bash
npm test
```

## Architecture

```
src/
  Wallet.js                top-level orchestrator
  KeyManager.js            BIP-39 seed + HD derivation
  paths.js                 derivation path definitions
  identity/Identity.js     signing, verification, ECIES, DID
  providers/               ChainProvider interface + WhatsOnChainProvider
  tx/                      coinSelect + TxBuilder (selectInputs/buildFromInputs for
                           pinned signing; uncheckedSerialize for 1-sat outputs)
  ordinals/Ordinals.js     1Sat inscription build/parse/transfer
  brc100/
    KeyDeriver.js          BRC-42/43 key derivation (ECDH + point math)
    cryptoOps.js           encrypt/decrypt/hmac/sign/verify
    storage.js             pluggable WalletStorage — baskets, certs, actions,
                           and persisted pending actions (MemoryStorage default)
    SqliteStorage.js       durable WalletStorage on node:sqlite (restart-survival)
    BRC100Wallet.js        full WalletInterface
```

## License

MIT
# web3keys2026
