#!/usr/bin/env node
'use strict';

/**
 * web3keys2 CLI — a thin driver over the library for quick manual testing.
 *
 * Usage:
 *   web3keys new                                  generate a wallet, print mnemonic + accounts
 *   web3keys info     --mnemonic "..."            show accounts/addresses for a mnemonic
 *   web3keys address  --mnemonic "..." [--account finance]
 *   web3keys sign     --mnemonic "..." --message "hi"
 *   web3keys verify   --mnemonic "..." --message "hi" --sig <base64> [--address <addr>]
 *   web3keys balance  --mnemonic "..." [--account finance] [--network livenet]
 *   web3keys identity-key --mnemonic "..."        print BRC-100 identity public key
 *   web3keys derive-pub  --mnemonic "..." --protocol "message signing" --keyid 1 [--counterparty self]
 *
 * Network commands (balance) require internet and use WhatsOnChain.
 */

const { Wallet, WhatsOnChainProvider } = require('../src');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function loadWallet(args) {
  if (!args.mnemonic) {
    console.error('Error: --mnemonic is required for this command');
    process.exit(1);
  }
  const network = args.network || 'livenet';
  const wallet = Wallet.fromMnemonic(args.mnemonic, { network });
  if (args.network !== undefined || ['balance'].includes(args._[0])) {
    wallet.setProvider(new WhatsOnChainProvider({ network }));
  }
  return wallet;
}

function out(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);

  switch (cmd) {
    case 'new': {
      const wallet = Wallet.generate({ network: args.network || 'livenet' });
      out({ mnemonic: wallet.mnemonic, identityKey: wallet.identity.identityKey, addresses: wallet.addresses() });
      break;
    }
    case 'info': {
      const wallet = loadWallet(args);
      out(wallet.keyManager.describe());
      break;
    }
    case 'address': {
      const wallet = loadWallet(args);
      out({ account: args.account || 'finance', address: wallet.keyManager.address(args.account || 'finance') });
      break;
    }
    case 'identity-key': {
      const wallet = loadWallet(args);
      out({ identityKey: wallet.identity.identityKey, did: wallet.identity.did() });
      break;
    }
    case 'sign': {
      const wallet = loadWallet(args);
      out({ message: args.message, signature: wallet.identity.sign(args.message), address: wallet.identity.address });
      break;
    }
    case 'verify': {
      const wallet = loadWallet(args);
      out({ valid: wallet.identity.verify(args.message, args.sig, args.address) });
      break;
    }
    case 'derive-pub': {
      const wallet = loadWallet(args);
      const res = await wallet.brc100.getPublicKey({
        protocolID: [Number(args.level || 2), args.protocol],
        keyID: String(args.keyid),
        counterparty: args.counterparty || 'self',
        forSelf: args.forself === true || args.forself === 'true',
      });
      out(res);
      break;
    }
    case 'balance': {
      const wallet = loadWallet(args);
      out(await wallet.getBalance(args.account || 'finance'));
      break;
    }
    default:
      console.log(require('fs').readFileSync(__filename, 'utf8').split('\n').slice(4, 22).join('\n').replace(/^ \* ?/gm, ''));
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
