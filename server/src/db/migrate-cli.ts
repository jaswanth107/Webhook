import { loadDotEnv } from '../config/dotenv.js';
loadDotEnv();

import { runMigrations } from './migrate.js';
import { closePool, waitForDatabase } from './pool.js';
import { log } from '../utils/logger.js';

await waitForDatabase();
const applied = await runMigrations();
log.info('MIGRATION_APPLIED', { appliedCount: applied.length, migrations: applied });
await closePool();
