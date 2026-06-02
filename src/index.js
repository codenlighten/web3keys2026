'use strict';

const bsv = require('@smartledger/bsv');

const { Wallet } = require('./Wallet');
const { KeyManager } = require('./KeyManager');
const { Identity } = require('./identity/Identity');
const { BRC100Wallet, VERSION: BRC100_VERSION } = require('./brc100/BRC100Wallet');
const { KeyDeriver, computeInvoiceNumber, normalizeProtocol } = require('./brc100/KeyDeriver');
const { CryptoOps } = require('./brc100/cryptoOps');
const { MemoryStorage } = require('./brc100/storage');
const { SqliteStorage } = require('./brc100/SqliteStorage');
const { ChainProvider } = require('./providers/ChainProvider');
const { WhatsOnChainProvider } = require('./providers/WhatsOnChainProvider');
const Ordinals = require('./ordinals/Ordinals');
const TxBuilder = require('./tx/TxBuilder');
const { coinSelect } = require('./tx/coinSelect');
const paths = require('./paths');

module.exports = {
  // top-level
  Wallet,
  KeyManager,
  Identity,
  // BRC-100
  BRC100Wallet,
  BRC100_VERSION,
  KeyDeriver,
  CryptoOps,
  MemoryStorage,
  SqliteStorage,
  computeInvoiceNumber,
  normalizeProtocol,
  // providers
  ChainProvider,
  WhatsOnChainProvider,
  // building blocks
  Ordinals,
  TxBuilder,
  coinSelect,
  paths,
  // underlying library, re-exported for advanced use
  bsv,
};
