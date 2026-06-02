'use strict';

const pino = require('pino');
const { config } = require('./config');

/**
 * Structured logger (pino). JSON in production for log shippers; pretty in dev if
 * pino-pretty is available. Never log secrets (seeds, shares, passwords, tokens).
 */
const logger = pino({
  level: process.env.LOG_LEVEL || (config.isProd ? 'info' : 'debug'),
  base: { service: 'web3keys-server' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.mnemonic',
      '*.share',
      '*.serverShare',
      '*.token',
    ],
    censor: '[redacted]',
  },
});

module.exports = { logger };
