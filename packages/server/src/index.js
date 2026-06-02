#!/usr/bin/env node
'use strict';

const { config, assertProductionConfig } = require('./config');
const { logger } = require('./logger');
const db = require('./db');
const session = require('./session');
const { createApp } = require('./app');

async function main() {
  assertProductionConfig();
  await db.init(); // run migrations
  session.startReaper();

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, env: config.env, network: config.network, domain: config.domain },
      'web3keys server listening'
    );
  });

  const shutdown = (sig) => {
    logger.info({ sig }, 'shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
