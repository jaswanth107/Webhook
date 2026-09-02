import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, withTransaction } from './pool.js';
import { log } from '../utils/logger.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, 'migrations');

/**
 * Forward-only SQL migrations, applied inside a transaction each, tracked in
 * schema_migrations. Safe to run on every boot and from multiple instances:
 * an advisory lock serialises concurrent runners.
 */
export async function runMigrations(): Promise<string[]> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const client = await pool.connect();
  const applied: string[] = [];
  try {
    // 4242 is an arbitrary but stable lock key for this application's migrations.
    await client.query('SELECT pg_advisory_lock($1)', [4242]);
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await withTransaction(async (tx) => {
        await tx.query(sql);
        await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      });
      applied.push(file);
      log.info('MIGRATION_APPLIED', { migration: file });
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [4242]).catch(() => undefined);
    client.release();
  }
  return applied;
}
