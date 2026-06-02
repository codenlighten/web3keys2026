'use strict';

const fs = require('fs');
const path = require('path');
const { query } = require('./pool');
const { logger } = require('../logger');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

/**
 * Minimal forward-only migration runner: applies migrations/*.sql in filename order,
 * each in its own transaction, tracking applied files in schema_migrations. Idempotent.
 */
async function migrate() {
  await query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await query('SELECT id FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.id));

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await query('BEGIN');
    try {
      await query(sql);
      await query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
      await query('COMMIT');
      count += 1;
      logger.info({ migration: file }, 'migration applied');
    } catch (err) {
      await query('ROLLBACK');
      logger.error({ migration: file, err }, 'migration failed');
      throw err;
    }
  }
  return { applied: count, total: files.length };
}

module.exports = { migrate };
