import pg from 'pg';
import { config } from '../config/env.js';
import { log, errorMessage } from '../utils/logger.js';

const { Pool } = pg;
export type PoolClient = pg.PoolClient;
export type QueryResultRow = pg.QueryResultRow;

// BIGINT (int8, oid 20) and NUMERIC come back as strings by default. Every bigint
// column in this schema is a counter or id that fits comfortably in a JS number.
pg.types.setTypeParser(20, (v: string) => Number(v));

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const cfg = config();
    pool = new Pool({
      connectionString: cfg.DATABASE_URL,
      max: cfg.PG_POOL_MAX,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: 'webhook-fortress',
    });
    pool.on('error', (err) => {
      log.error('WORKER_ERROR', { scope: 'pg_pool', message: errorMessage(err) });
    });
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as never[]);
}

/**
 * Runs `fn` inside a single transaction on a dedicated connection.
 * Any throw rolls the transaction back -- which is exactly what makes a crash
 * mid-processing safe: an uncommitted business effect never existed.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection is already gone; nothing to roll back client-side */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

/** Waits for the database to accept connections (used on boot / in Docker). */
export async function waitForDatabase(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await query('SELECT 1');
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`Database not reachable within ${timeoutMs}ms: ${errorMessage(lastError)}`);
}

/**
 * Narrow interface satisfied by both a Pool and a PoolClient, so repository
 * functions can run either standalone or inside a caller's transaction.
 */
export interface Db {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<pg.QueryResult<T>>;
}

export function db(client?: PoolClient): Db {
  return (client ?? getPool()) as unknown as Db;
}
