/**
 * End-to-end hostility test orchestrator.
 *
 *   npm run test:hostile
 *
 * 1. brings up the Docker stack (Postgres + receiver) and waits for health
 * 2. resets the database
 * 3. runs the hostile sender (1,000 logical events, duplicates, storm,
 *    out-of-order arrival, forged signatures, one mid-flight kill)
 * 4. waits for processing to settle
 * 5. runs the database verification and prints PASS / FAIL
 *
 * Flags: --no-docker (use an already-running receiver), --events N, --no-crash
 */
import { spawnSync } from 'node:child_process';
import { loadDotEnv } from '../server/src/config/dotenv.js';
loadDotEnv();

import { waitForHealth } from './lib/sender.js';

const argv = process.argv.slice(2);
const useDocker = !argv.includes('--no-docker');
const baseUrl = process.env.RECEIVER_URL ?? 'http://localhost:3000';

function run(cmd: string, args: string[], label: string): number {
  console.log(`\n▸ ${label}\n  $ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', env: process.env });
  return res.status ?? 1;
}

function heading(text: string): void {
  console.log(`\n${'█'.repeat(62)}`);
  console.log(`█  ${text.padEnd(57)}█`);
  console.log('█'.repeat(62));
}

async function main(): Promise<void> {
  heading('WEBHOOK FORTRESS — HOSTILITY TEST');

  if (useDocker) {
    if (run('docker', ['compose', 'up', '--build', '-d'], 'Starting Docker stack (db + receiver)') !== 0) {
      throw new Error('docker compose up failed');
    }
  } else {
    console.log('\n▸ Using the already-running receiver (--no-docker)');
  }

  console.log('\n▸ Waiting for the receiver to become healthy…');
  if (!(await waitForHealth(baseUrl, 120_000))) throw new Error(`Receiver at ${baseUrl} never became healthy`);
  console.log('  receiver is healthy');

  console.log('\n▸ Resetting the database');
  const reset = await fetch(`${baseUrl}/admin/chaos/reset`, { method: 'POST' }).catch(() => null);
  if (!reset || !reset.ok) {
    // Chaos endpoints disabled -> fall back to the direct database reset.
    if (run('npx', ['tsx', 'scripts/db-reset.ts'], 'Resetting database directly') !== 0) {
      throw new Error('database reset failed');
    }
  } else {
    console.log('  all event tables truncated');
  }

  const senderArgs = ['tsx', 'scripts/send-1000-events.ts', ...argv.filter((a) => a !== '--no-docker')];
  heading('PHASE 1 — HOSTILE DELIVERY');
  if (run('npx', senderArgs, 'Sending 1,000 hostile events') !== 0) throw new Error('sender failed');

  heading('PHASE 2 — DATABASE VERIFICATION');
  const verifyStatus = run('npx', ['tsx', 'scripts/verify-results.ts'], 'Verifying database state');

  heading(verifyStatus === 0 ? 'RESULT: PASS' : 'RESULT: FAIL');
  if (verifyStatus === 0) {
    console.log('\nEvery valid event is accounted for exactly once. Dashboard: ' + baseUrl + '\n');
  }
  process.exit(verifyStatus);
}

main().catch((err) => {
  console.error('\nHostility test failed:', err);
  process.exit(1);
});
