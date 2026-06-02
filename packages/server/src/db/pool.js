'use strict';

const { config } = require('../config');
const { logger } = require('../logger');

/**
 * Postgres connection pool.
 *
 * - If DATABASE_URL is set → a real `pg` Pool (production / integration tests).
 * - Otherwise → an in-memory Postgres via `pg-mem` (unit tests, quick local runs),
 *   so `npm test` needs no external database. Same SQL, same query interface.
 */
let pool;

function createPool() {
  if (config.databaseUrl) {
    const { Pool } = require('pg');
    const p = new Pool({
      connectionString: config.databaseUrl,
      max: Number(process.env.PG_POOL_MAX || 10),
      idleTimeoutMillis: 30000,
    });
    p.on('error', (err) => logger.error({ err }, 'pg pool error'));
    return p;
  }
  // In-memory fallback.
  const { newDb } = require('pg-mem');
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const pg = mem.adapters.createPg();
  return new pg.Pool();
}

function getPool() {
  if (!pool) pool = createPool();
  return pool;
}

/** Run a parameterized query. */
async function query(text, params) {
  return getPool().query(text, params);
}

/** Convenience: first row or null. */
async function one(text, params) {
  const { rows } = await query(text, params);
  return rows[0] || null;
}

async function close() {
  if (pool && pool.end) await pool.end();
  pool = undefined;
}

module.exports = { getPool, query, one, close, usingMemory: () => !config.databaseUrl };
