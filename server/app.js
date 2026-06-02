'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');
const { config } = require('./config');
const { router: apiRouter } = require('./routes');
const { router: paymailRouter } = require('./paymail');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/** Build the Express app (no listen) — importable for tests. */
function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Behind nginx: trust the first proxy hop so client IPs (and rate limiting) are correct.
  app.set('trust proxy', 1);
  app.use(cors());
  app.use(express.json({ limit: '256kb' }));

  // Static frontend (register/login SPA). API/paymail routes below are unaffected
  // since no static file matches those paths.
  app.use(express.static(PUBLIC_DIR));

  app.get('/health', (req, res) => res.json({ ok: true, network: config.network, domain: config.domain }));

  // Paymail (serves /.well-known/bsvalias and /api/paymail/*) and the app API.
  app.use(paymailRouter);
  app.use(apiRouter);

  // 404
  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  // Error handler — maps ServiceError.status, hides internals otherwise.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) {
      // eslint-disable-next-line no-console
      console.error('[error]', err.message);
    }
    res.status(status).json({ error: status >= 500 ? 'internal error' : err.message });
  });

  return app;
}

module.exports = { createApp };
