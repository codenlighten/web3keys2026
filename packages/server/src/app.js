'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const pinoHttp = require('pino-http');
const { config } = require('./config');
const { logger } = require('./logger');
const dbPool = require('./db/pool');
const { hasRedis, pingRedis } = require('./redis');
const { router: apiRouter } = require('./routes');
const { router: paymailRouter } = require('./paymail');

// Static frontend lives in the web workspace (packages/web). Overridable via WEB_DIR
// (e.g. to serve a built React app from packages/web/dist in Phase 5).
const PUBLIC_DIR = process.env.WEB_DIR || path.join(__dirname, '..', '..', 'web');

/** Build the Express app (no listen) — importable for tests. */
function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Behind nginx: trust the first proxy hop so client IPs (and rate limiting) are correct.
  app.set('trust proxy', 1);

  // Request logging with a per-request id (quiet during tests).
  if (config.env !== 'test') {
    app.use(
      pinoHttp({
        logger,
        genReqId: (req, res) => {
          const id = req.headers['x-request-id'] || crypto.randomUUID();
          res.setHeader('x-request-id', id);
          return id;
        },
        autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/healthz' },
      })
    );
  }

  app.use(cors());
  app.use(express.json({ limit: '256kb' }));

  // Static frontend (register/login SPA). API/paymail routes below are unaffected
  // since no static file matches those paths.
  app.use(express.static(PUBLIC_DIR));

  app.get('/health', (req, res) =>
    res.json({ ok: true, network: config.network, domain: config.domain })
  );

  // Liveness: process is up.
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // Readiness: dependencies (Postgres, Redis) are reachable.
  app.get('/readyz', async (req, res) => {
    const checks = { postgres: false, redis: 'n/a' };
    try {
      await dbPool.query('SELECT 1');
      checks.postgres = true;
    } catch {
      /* not ready */
    }
    if (hasRedis()) checks.redis = await pingRedis();
    const ready = checks.postgres && checks.redis !== false;
    res.status(ready ? 200 : 503).json({ ready, checks });
  });

  // Paymail (serves /.well-known/bsvalias and /api/paymail/*) and the app API.
  app.use(paymailRouter);
  app.use(apiRouter);

  // 404
  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  // Error handler — maps ServiceError.status, hides internals otherwise.

  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) {
      (req.log || logger).error({ err }, 'request failed');
    }
    res.status(status).json({ error: status >= 500 ? 'internal error' : err.message });
  });

  return app;
}

module.exports = { createApp };
