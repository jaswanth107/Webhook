import { loadDotEnv } from './config/dotenv.js';
loadDotEnv();

import { config } from './config/env.js';
import { buildApp } from './app.js';
import { runMigrations } from './db/migrate.js';
import { closePool, waitForDatabase } from './db/pool.js';
import { runStartupRecovery } from './services/recovery.js';
import { eventWorker } from './workers/eventWorker.js';
import { errorMessage, log, setLogLevel } from './utils/logger.js';

async function main(): Promise<void> {
  const cfg = config();
  setLogLevel(cfg.LOG_LEVEL);

  await waitForDatabase();
  await runMigrations();

  // Recovery runs BEFORE the listener opens: by the time we accept traffic,
  // everything a previous (possibly killed) process left behind is queued again.
  await runStartupRecovery();

  const app = await buildApp();

  if (cfg.WORKER_ENABLED) eventWorker.start();

  await app.listen({ port: cfg.PORT, host: cfg.HOST });

  log.info('SERVER_STARTED', {
    port: cfg.PORT,
    pid: process.pid,
    workerEnabled: cfg.WORKER_ENABLED,
    maxProcessingAttempts: cfg.MAX_PROCESSING_ATTEMPTS,
    retryBaseDelayMs: cfg.RETRY_BASE_DELAY_MS,
    processingTimeoutSeconds: cfg.PROCESSING_TIMEOUT_SECONDS,
    simulateFailures: cfg.SIMULATE_FAILURES,
    chaosEnabled: cfg.CHAOS_ENABLED,
    simulateCrashEvent: cfg.SIMULATE_CRASH_EVENT ?? null,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('SERVER_STOPPING', { signal });
    try {
      await app.close();
      await eventWorker.stop();
      await closePool();
    } catch (err) {
      log.error('WORKER_ERROR', { scope: 'shutdown', message: errorMessage(err) });
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log.error('WORKER_ERROR', { scope: 'unhandledRejection', message: errorMessage(reason) });
  });
}

main().catch((err) => {
  log.error('WORKER_ERROR', { scope: 'bootstrap', message: errorMessage(err) });
  process.exit(1);
});
