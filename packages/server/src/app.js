'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const pinoHttp = require('pino-http');
const { config } = require('./config');
const { logger } = require('./logger');
const dbPool = require('./db/pool');
const { hasRedis, pingRedis } = require('./redis');
const { metricsMiddleware, metricsHandler } = require('./metrics');
const { router: apiRouter } = require('./routes');
const { router: paymailRouter } = require('./paymail');
const { router: ssoRouter } = require('./sso');

// Static frontend: the built Vite/React app (packages/web/dist). Overridable via WEB_DIR.
const PUBLIC_DIR = process.env.WEB_DIR || path.join(__dirname, '..', '..', 'web', 'dist');

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

  // Security headers + CSP. script-src allows the @smartledger/bsv CDN the SPA loads;
  // tighten further once the React build (Phase 5) bundles its own JS.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      frameguard: { action: 'deny' }, // X-Frame-Options: DENY (CSP frame-ancestors backs this)
    })
  );

  // Permissions-Policy: deny powerful features outright (helmet doesn't set this).
  app.use((req, res, next) => {
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()'
    );
    next();
  });

  app.use(cors());
  app.use(express.json({ limit: '256kb' }));
  app.use(metricsMiddleware);

  // Prometheus scrape endpoint (optionally token-gated via METRICS_TOKEN).
  app.get('/metrics', metricsHandler);

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

  // Paymail (serves /.well-known/bsvalias and /api/paymail/*), SmartLedger Login SSO
  // (/api/verify-login etc.), and the app API.
  app.use(paymailRouter);
  app.use(ssoRouter);
  app.use(apiRouter);

  // SPA fallback: serve index.html for client-side routes (dashboard, and the
  // SmartLedger Login approval pages /login /attest /publish that sl-login.js
  // redirects to) so deep links resolve. API/well-known/static paths matched above.
  const indexHtml = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (req.path.startsWith('/api') || req.path.startsWith('/.well-known')) return next();
      if (!req.accepts('html')) return next();
      res.sendFile(indexHtml);
    });
  }

  // 404
  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  // Error handler — maps ServiceError.status, hides internals otherwise.

  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) {
      (req.log || logger).error({ err }, 'request failed');
    }
    const body = { error: status >= 500 ? 'internal error' : err.message };
    if (status < 500 && err.extra) Object.assign(body, err.extra);
    res.status(status).json(body);
  });

  return app;
}

module.exports = { createApp };
