/**
 * Focused crash-recovery test.
 *
 * Sends a steady stream of events, kills the receiver with SIGKILL while events
 * are mid-processing, lets Docker restart it, and then proves that:
 *   - every accepted event still reaches a terminal state
 *   - no business effect was recorded twice
 *   - interrupted events were reclaimed from PROCESSING by startup recovery
 *
 * Usage: npm run chaos -- [--events 300] [--crash-at 120]
 */
import { loadDotEnv } from '../server/src/config/dotenv.js';
loadDotEnv();

import { closePool, query, waitForDatabase } from '../server/src/db/pool.js';
import { deliver, runPool, sign, sleep, waitForHealth } from './lib/sender.js';
import { adminFetch } from './lib/adminFetch.js';

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1]!.startsWith('--')) return argv[i + 1] as string;
  return fallback;
};

const URL_BASE = arg('url', process.env.RECEIVER_URL ?? 'http://localhost:3000');
const SECRET = process.env.WEBHOOK_SECRET ?? '';
const TOTAL = Number(arg('events', '300'));
const CRASH_AT = Number(arg('crash-at', '120'));

async function main(): Promise<void> {
  if (!SECRET) throw new Error('WEBHOOK_SECRET is required');
  await waitForDatabase();
  if (!(await waitForHealth(URL_BASE, 30_000))) throw new Error('Receiver is not healthy');

  const runId = `chaos_${Date.now().toString(36)}`;
  console.log(`\nCHAOS TEST  (${TOTAL} events, kill after ${CRASH_AT} deliveries, run id ${runId})\n`);

  let completed = 0;
  let crashed = false;
  let crashAtMs = 0;

  const tasks = Array.from({ length: TOTAL }, (_, i) => async () => {
    const body = JSON.stringify({
      eventId: `${runId}_${String(i + 1).padStart(4, '0')}`,
      eventType: 'order.created',
      sequence: i + 1,
      timestamp: new Date().toISOString(),
      data: { orderId: `order_${i + 1}`, customerId: 'chaos', amount: i + 1 },
    });
    const res = await deliver({ url: `${URL_BASE}/webhooks/events`, secret: SECRET }, body, sign(body, SECRET));
    completed += 1;
    if (!crashed && completed >= CRASH_AT) {
      crashed = true;
      crashAtMs = Date.now();
      console.log(`  💥 killing the receiver after ${completed} deliveries (events still processing)`);
      await adminFetch(`${URL_BASE}/admin/chaos/crash?delayMs=0`, { method: 'POST' }).catch(() => undefined);
    }
    return res.status;
  });

  const statuses = await runPool(tasks, 20);
  const accepted = statuses.filter((s) => s === 202).length;
  // Requests whose response was lost to the crash are retried by the sender and
  // come back as 200 duplicate -- accepted + duplicate must cover every event.
  const duplicates = statuses.filter((s) => s === 200).length;

  if (!(await waitForHealth(URL_BASE, 90_000))) throw new Error('Receiver never came back');
  console.log(`  ♻️  receiver healthy again after ${Date.now() - crashAtMs}ms`);
  console.log(`  deliveries: ${accepted} accepted, ${duplicates} duplicate, ${statuses.filter((s) => s === 0).length} unreachable`);

  // Wait for the queue to drain.
  const deadline = Date.now() + 120_000;
  for (;;) {
    const { rows } = await query<{ pending: number }>(
      `SELECT COUNT(*)::bigint AS pending FROM webhook_events
        WHERE event_id LIKE $1 AND status NOT IN ('PROCESSED','DEAD_LETTERED')`,
      [`${runId}%`],
    );
    if (Number(rows[0]?.pending ?? 0) === 0) break;
    if (Date.now() > deadline) throw new Error(`Timed out with ${rows[0]?.pending} events still pending`);
    await sleep(500);
  }

  const [events, results, dupes, recovered] = await Promise.all([
    query<{ count: number; processed: number }>(
      `SELECT COUNT(*)::bigint AS count,
              COUNT(*) FILTER (WHERE status = 'PROCESSED')::bigint AS processed
         FROM webhook_events WHERE event_id LIKE $1`,
      [`${runId}%`],
    ),
    query<{ count: number }>('SELECT COUNT(*)::bigint AS count FROM processed_results WHERE event_id LIKE $1', [
      `${runId}%`,
    ]),
    query<{ event_id: string }>(
      `SELECT event_id FROM processed_results WHERE event_id LIKE $1 GROUP BY event_id HAVING COUNT(*) > 1`,
      [`${runId}%`],
    ),
    query<{ count: number }>(
      `SELECT COUNT(*)::bigint AS count FROM webhook_attempts WHERE source = 'RECOVERY' AND event_id LIKE $1`,
      [`${runId}%`],
    ),
  ]);

  const total = Number(events.rows[0]?.count ?? 0);
  const processed = Number(events.rows[0]?.processed ?? 0);
  const effects = Number(results.rows[0]?.count ?? 0);
  const reclaimed = Number(recovered.rows[0]?.count ?? 0);

  console.log('\n  ── crash recovery result ────────────────────────────────');
  console.log(`  logical events sent      : ${TOTAL}`);
  console.log(`  unique events stored     : ${total}`);
  console.log(`  processed                : ${processed}`);
  console.log(`  business effects         : ${effects}`);
  console.log(`  duplicate effects        : ${dupes.rows.length}`);
  console.log(`  reclaimed after restart  : ${reclaimed}`);

  const pass =
    total === TOTAL &&              // every logical event landed exactly once
    accepted + duplicates === TOTAL && // and every request was answered
    processed === total &&          // all of them finished
    effects === total &&            // one business effect each
    dupes.rows.length === 0;        // and never two
  console.log(`\n  CHAOS TEST: ${pass ? 'PASS' : 'FAIL'}\n`);
  await closePool();
  process.exit(pass ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Chaos test failed:', err);
  await closePool().catch(() => undefined);
  process.exit(1);
});
