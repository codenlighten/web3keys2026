#!/usr/bin/env node
'use strict';

const { config, assertProductionConfig } = require('./config');
const db = require('./db');
const session = require('./session');
const { createApp } = require('./app');

function main() {
  assertProductionConfig();
  db.init();
  session.startReaper();

  const app = createApp();
  const server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`web3keys server listening on :${config.port} (${config.env}, ${config.network}, ${config.domain})`);
  });

  const shutdown = (sig) => {
    // eslint-disable-next-line no-console
    console.log(`\n${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
