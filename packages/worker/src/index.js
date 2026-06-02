'use strict';

// web3keys background worker. Hosts BullMQ queues; Phase 1 wires the process,
// connection, and the queues. Job logic (incoming-payment detection, notifications,
// email, webhooks) is implemented in Phase 4.

const pino = require('pino');

const logger = pino({ base: { service: 'web3keys-worker' } });
const REDIS_URL = process.env.REDIS_URL;
const SYNC_INTERVAL_MS = Number(process.env.CHAIN_SYNC_INTERVAL_MS || 300_000);

const QUEUES = ['chain-sync', 'notifications', 'email', 'webhooks'];

// Poll the chain for new deposits across all users (requires DATABASE_URL). Each pass
// records 'in' transactions + 'deposit' notifications; idempotent.
function startDepositSync() {
  if (!process.env.DATABASE_URL) {
    logger.warn('DATABASE_URL not set — deposit sync disabled');
    return;
  }
  const { migrate } = require('@web3keys/server/src/db/migrate');
  const chainsync = require('@web3keys/server/src/chainsync');
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const n = await chainsync.syncAll();
      if (n) logger.info({ newDeposits: n }, 'deposit sync pass');
    } catch (err) {
      logger.error({ err }, 'deposit sync error');
    } finally {
      running = false;
    }
  };
  migrate()
    .then(() => {
      const timer = setInterval(tick, SYNC_INTERVAL_MS);
      timer.unref();
      tick();
      logger.info({ intervalMs: SYNC_INTERVAL_MS }, 'deposit sync started');
    })
    .catch((err) => logger.error({ err }, 'migrate failed; deposit sync not started'));
}

async function main() {
  startDepositSync();
  if (!REDIS_URL) {
    logger.warn(
      'REDIS_URL not set — worker cannot run BullMQ; idling. Set REDIS_URL in production.'
    );
    return;
  }

  const IORedis = require('ioredis');
  const { Worker } = require('bullmq');
  const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  connection.on('error', (err) => logger.error({ err }, 'redis error'));

  const workers = QUEUES.map(
    (name) =>
      new Worker(
        name,
        async (job) => {
          // Placeholder processor — real handlers land in Phase 4.
          logger.info({ queue: name, jobId: job.id, name: job.name }, 'processing job');
          return { ok: true };
        },
        { connection }
      )
  );

  logger.info({ queues: QUEUES }, 'worker started');

  const shutdown = async (sig) => {
    logger.info({ sig }, 'worker shutting down');
    await Promise.all(workers.map((w) => w.close()));
    await connection.quit();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'worker fatal error');
  process.exit(1);
});
