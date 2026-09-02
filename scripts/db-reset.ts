/** Truncates every table (keeps the schema) so a test run starts from zero. */
import { loadDotEnv } from '../server/src/config/dotenv.js';
loadDotEnv();

import { closePool, query, waitForDatabase } from '../server/src/db/pool.js';
import { runMigrations } from '../server/src/db/migrate.js';

await waitForDatabase();
await runMigrations();
await query(
  'TRUNCATE processed_results, dead_letter_events, webhook_attempts, security_events, webhook_events RESTART IDENTITY CASCADE',
);
console.log('Database reset: all event tables truncated.');
await closePool();
