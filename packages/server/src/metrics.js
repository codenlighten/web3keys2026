'use strict';

const client = require('prom-client');
const { config } = require('./config');

/**
 * Prometheus metrics. Default Node/process metrics plus HTTP request duration and a few
 * business counters. Exposed at GET /metrics (optionally gated by METRICS_TOKEN); scrape
 * it with Prometheus / DigitalOcean monitoring. Route labels use the matched route path
 * (not the raw URL) to keep cardinality bounded.
 */
const register = new client.Registry();
register.setDefaultLabels({ service: 'web3keys-server' });
client.collectDefaultMetrics({ register });

const httpDuration = new client.Histogram({
  name: 'web3keys_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.05, 0.1, 0.3, 1, 3],
  registers: [register],
});

const events = new client.Counter({
  name: 'web3keys_events_total',
  help: 'Business events (logins, registrations, broadcasts, etc.)',
  labelNames: ['event', 'result'],
  registers: [register],
});

/** Increment a business event counter, e.g. recordEvent('login', 'success'). */
function recordEvent(event, result = 'ok') {
  events.inc({ event, result });
}

/** Express middleware: time each request, labeled by the matched route. */
function metricsMiddleware(req, res, next) {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    const route = (req.route && req.baseUrl + req.route.path) || req.path || 'unknown';
    end({ method: req.method, route, status: res.statusCode });
  });
  next();
}

/** Handler for GET /metrics (optionally token-gated). */
async function metricsHandler(req, res) {
  if (config.metricsToken && req.headers['x-metrics-token'] !== config.metricsToken) {
    return res.status(401).end();
  }
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
}

module.exports = { register, recordEvent, metricsMiddleware, metricsHandler };
