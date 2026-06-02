'use strict';

const express = require('express');
const { bsv } = require('@web3keys/wallet-core');
const { config } = require('./config');
const db = require('./db');
const svc = require('./walletService');

/**
 * Paymail (bsvalias) endpoints. Implements the core capabilities:
 *   - capability discovery  (.well-known/bsvalias)
 *   - pki                    0c4339ef99c2b480
 *   - paymentDestination     759684b1a19a
 *   - public profile         f12f968c92d6
 *
 * Mounted so that GET /.well-known/bsvalias and /api/paymail/* are reachable.
 */
const router = express.Router();

const CAP = {
  pki: '0c4339ef99c2b480',
  paymentDestination: '759684b1a19a',
  publicProfile: 'f12f968c92d6',
};

function lookup(paymail) {
  const [alias, domain] = String(paymail || '')
    .toLowerCase()
    .split('@');
  if (!alias || domain !== config.domain.toLowerCase()) return null;
  return db.findByAlias(alias);
}

// Capability discovery document.
router.get('/.well-known/bsvalias', (req, res) => {
  const u = config.baseUrl;
  res.json({
    bsvalias: '1.0',
    capabilities: {
      [CAP.pki]: `${u}/api/paymail/id/{alias}@{domain.tld}`,
      [CAP.paymentDestination]: `${u}/api/paymail/address/{alias}@{domain.tld}`,
      [CAP.publicProfile]: `${u}/api/paymail/public-profile/{alias}@{domain.tld}`,
    },
  });
});

// PKI: identity public key for a handle.
router.get('/api/paymail/id/:paymail', (req, res) => {
  const user = lookup(req.params.paymail);
  if (!user) return res.status(404).json({ error: 'paymail not found' });
  res.json({
    bsvalias: '1.0',
    handle: req.params.paymail.toLowerCase(),
    pubkey: user.identity_pubkey,
  });
});

// Public profile.
router.get('/api/paymail/public-profile/:paymail', (req, res) => {
  const user = lookup(req.params.paymail);
  if (!user) return res.status(404).json({ error: 'paymail not found' });
  res.json({ name: user.alias, avatar: '' });
});

// Payment destination: return a P2PKH locking script for the recipient.
router.post('/api/paymail/address/:paymail', (req, res) => {
  const user = lookup(req.params.paymail);
  if (!user) return res.status(404).json({ error: 'paymail not found' });
  const address = svc.depositAddress(user);
  const script = bsv.Script.buildPublicKeyHashOut(new bsv.Address(address)).toHex();
  res.json({ output: script });
});

module.exports = { router, CAP };
