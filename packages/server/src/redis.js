'use strict';

const { config } = require('./config');
const { logger } = require('./logger');

/**
 * Redis client (ioredis) used for cross-node session records, shared rate limiting,
 * caching, and the BullMQ job queue. If REDIS_URL is not configured, callers fall
 * back to in-memory equivalents (single-node only) — see session.js / rateLimit.js.
 */
let client = null;

function getRedis() {
  if (client !== null) return client;
  if (!config.redisUrl) {
    client = undefined; // explicit "no redis configured"
    return client;
  }
  const IORedis = require('ioredis');
  client = new IORedis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });
  client.on('error', (err) => logger.error({ err }, 'redis error'));
  return client;
}

/** Is a real Redis configured? */
function hasRedis() {
  return !!config.redisUrl;
}

async function pingRedis() {
  const r = getRedis();
  if (!r) return false;
  try {
    return (await r.ping()) === 'PONG';
  } catch {
    return false;
  }
}

async function closeRedis() {
  if (client && client.quit) await client.quit();
  client = null;
}

module.exports = { getRedis, hasRedis, pingRedis, closeRedis };
