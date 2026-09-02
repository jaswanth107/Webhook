import { loadDotEnv } from '../server/src/config/dotenv.js';
loadDotEnv();

// Tests need the deterministic failure handlers regardless of the .env value.
process.env.SIMULATE_FAILURES = 'true';
// ...but never the kill switch: /admin/chaos/crash would SIGKILL the test run.
process.env.CHAOS_ENABLED = 'false';
delete process.env.SIMULATE_CRASH_EVENT;
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
process.env.WORKER_ENABLED = 'false'; // tests drive the worker by hand

// Tests run against their own database so a hostility-test run's data is never
// clobbered (and vice versa).
const adminUrl = process.env.DATABASE_URL as string;
const testUrl =
  process.env.TEST_DATABASE_URL ?? adminUrl.replace(/\/[^/?]+(\?|$)/, '/webhook_fortress_test$1');
process.env.DATABASE_URL = testUrl;

import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/src/app.js';
import { runMigrations } from '../server/src/db/migrate.js';
import { closePool, query, waitForDatabase } from '../server/src/db/pool.js';
import { config } from '../server/src/config/env.js';
import { setLogLevel, type LogLevel } from '../server/src/utils/logger.js';
import { sign } from '../scripts/lib/sender.js';

// ESM imports are hoisted, so setting process.env.LOG_LEVEL above is too late
// for the logger module -- set the level through its API instead.
setLogLevel((process.env.TEST_LOG_LEVEL as LogLevel) ?? 'silent');

export { query, closePool, config, sign };

let app: FastifyInstance | null = null;

async function ensureTestDatabase(): Promise<void> {
  const name = new URL(testUrl).pathname.slice(1);
  const admin = new pg.Client({ connectionString: adminUrl.replace(/\/[^/?]+(\?|$)/, '/postgres$1') });
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (rows.length === 0) await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
}

export async function getApp(): Promise<FastifyInstance> {
  if (!app) {
    await ensureTestDatabase();
    await waitForDatabase();
    await runMigrations();
    app = await buildApp();
    await app.ready();
  }
  return app;
}

export async function shutdown(): Promise<void> {
  if (app) await app.close();
  app = null;
  await closePool();
}

export async function truncateAll(): Promise<void> {
  await query(
    'TRUNCATE processed_results, dead_letter_events, webhook_attempts, security_events, webhook_events RESTART IDENTITY CASCADE',
  );
}

export interface TestEventOptions {
  eventId?: string;
  eventType?: string;
  sequence?: number;
  data?: Record<string, unknown>;
}

export function makeEvent(opts: TestEventOptions = {}): string {
  return JSON.stringify({
    eventId: opts.eventId ?? `evt_test_${Math.random().toString(36).slice(2, 10)}`,
    eventType: opts.eventType ?? 'order.created',
    sequence: opts.sequence ?? 1,
    timestamp: new Date().toISOString(),
    data: opts.data ?? { orderId: 'order_1', customerId: 'customer_1', amount: 100 },
  });
}

/** POSTs a body to the webhook endpoint with an optionally broken signature. */
export async function post(
  body: string,
  options: { signature?: string | null; secret?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const instance = await getApp();
  const cfg = config();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const signature =
    options.signature === undefined ? sign(body, options.secret ?? cfg.WEBHOOK_SECRET) : options.signature;
  if (signature !== null) headers[cfg.SIGNATURE_HEADER] = signature;

  const res = await instance.inject({ method: 'POST', url: '/webhooks/events', headers, payload: body });
  let json: Record<string, unknown> = {};
  try {
    json = res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.statusCode, json };
}
