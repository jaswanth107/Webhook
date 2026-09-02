/**
 * Database verification.
 *
 * Reads tmp/hostile-manifest.json (what the sender actually sent) and proves,
 * with SQL, that the receiver's state is exactly what correctness demands:
 * every valid event accounted for exactly once, no duplicate business effects,
 * no rejected request in the inbox, retries and dead letters where expected.
 *
 * Exits non-zero if any check fails.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDotEnv } from '../server/src/config/dotenv.js';
loadDotEnv();

import { closePool, query, waitForDatabase } from '../server/src/db/pool.js';
import { sleep } from './lib/sender.js';

interface ManifestLogicalEvent {
  eventId: string;
  eventType: string;
  sequence: number;
  deliveries: number;
  expectedTerminalStatus: 'PROCESSED' | 'DEAD_LETTERED';
  minAttempts: number;
  category: string;
}

interface Manifest {
  counts: { logicalEvents: number; totalValidDeliveries: number; totalInvalidDeliveries: number; duplicateDeliveries: number };
  storm: {
    eventId: string;
    deliveries: number;
    statusCounts?: Record<string, number>;
    durationMs?: number;
    requestsIssued?: number;
  };
  crash: { triggered: boolean; triggeredAtDelivery: number; downtimeMs: number };
  invalid: {
    wrongSignature: number;
    missingSignature: number;
    tamperedBody: number;
    invalidSchema: number;
    invalidJson: number;
    eventIdsThatMustNeverExist: string[];
  };
  statusCounts: Record<string, number>;
  outOfOrder: { inversions: number; maxInversions: number; ratio: number };
  logicalEvents: ManifestLogicalEvent[];
}

interface Check {
  name: string;
  expected: string;
  actual: string;
  pass: boolean;
  detail?: string;
}

const argv = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const withEq = argv.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.split('=').slice(1).join('=');
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1]!.startsWith('--')) return argv[i + 1];
  return undefined;
};

const MANIFEST_PATH = resolve(argValue('manifest') ?? 'tmp/hostile-manifest.json');
const STABILISE_TIMEOUT_MS = Number(argValue('stabilise-ms') ?? 180_000);
const SKIP_WAIT = argv.includes('--no-wait');

const num = (v: unknown): number => Number(v ?? 0);

/** Waits until no event is left in a non-terminal state (or the timeout expires). */
async function waitForStable(timeoutMs: number): Promise<{ stable: boolean; waitedMs: number }> {
  const started = Date.now();
  let lastPending = -1;
  while (Date.now() - started < timeoutMs) {
    const { rows } = await query<{ pending: number }>(
      `SELECT COUNT(*)::bigint AS pending FROM webhook_events
        WHERE status NOT IN ('PROCESSED', 'DEAD_LETTERED')`,
    );
    const pending = num(rows[0]?.pending);
    if (pending === 0) return { stable: true, waitedMs: Date.now() - started };
    if (pending !== lastPending) {
      process.stdout.write(`  waiting for processing to settle… ${pending} events still in flight\n`);
      lastPending = pending;
    }
    await sleep(500);
  }
  return { stable: false, waitedMs: Date.now() - started };
}

async function main(): Promise<void> {
  await waitForDatabase();

  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(
      `Manifest not found at ${MANIFEST_PATH}. Run "npm run send:1000" (or "npm run test:hostile") first.`,
    );
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;

  let stabilised = { stable: true, waitedMs: 0 };
  if (!SKIP_WAIT) stabilised = await waitForStable(STABILISE_TIMEOUT_MS);

  // ---- raw queries --------------------------------------------------------
  const [
    q1, q2, q4, q5, q6, q7accepted, q7security, storm, dupDeliveries,
    processedCount, deadCount, resultCount, processedWithoutResult, deadWithResult,
    recoveryRows, attemptsAgg, deliverySum,
  ] = await Promise.all([
    query<{ event_rows: number; unique_event_ids: number }>(
      'SELECT COUNT(*)::bigint AS event_rows, COUNT(DISTINCT event_id)::bigint AS unique_event_ids FROM webhook_events',
    ),
    query<{ event_id: string; effects: number }>(
      'SELECT event_id, COUNT(*)::bigint AS effects FROM processed_results GROUP BY event_id HAVING COUNT(*) > 1',
    ),
    query<{ event_id: string; status: string; processing_attempts: number }>(
      `SELECT event_id, status, processing_attempts FROM webhook_events
        WHERE status NOT IN ('PROCESSED','DEAD_LETTERED') ORDER BY event_id LIMIT 50`,
    ),
    query<{ original_event_id: string; total_attempts: number; failure_reason: string }>(
      'SELECT original_event_id, total_attempts, failure_reason FROM dead_letter_events ORDER BY original_event_id',
    ),
    query<{ event_id: string; processing_attempts: number; status: string }>(
      'SELECT event_id, processing_attempts, status FROM webhook_events WHERE processing_attempts > 1 ORDER BY processing_attempts DESC, event_id',
    ),
    query<{ count: number }>(
      `SELECT COUNT(*)::bigint AS count FROM webhook_events
        WHERE event_id = ANY($1::text[])`,
      [manifest.invalid.eventIdsThatMustNeverExist],
    ),
    query<{ reason: string; count: number }>(
      'SELECT reason, COUNT(*)::bigint AS count FROM security_events GROUP BY reason',
    ),
    query<{ event_id: string; delivery_count: number; status: string; effects: number; attempts: number }>(
      `SELECT e.event_id, e.delivery_count, e.status, e.processing_attempts AS attempts,
              (SELECT COUNT(*)::bigint FROM processed_results r WHERE r.event_id = e.event_id) AS effects
         FROM webhook_events e WHERE e.event_id = $1`,
      [manifest.storm.eventId],
    ),
    query<{ event_id: string; delivery_count: number; effects: number }>(
      `SELECT e.event_id, e.delivery_count,
              (SELECT COUNT(*)::bigint FROM processed_results r WHERE r.event_id = e.event_id) AS effects
         FROM webhook_events e WHERE e.delivery_count > 1 ORDER BY e.delivery_count DESC`,
    ),
    query<{ count: number }>("SELECT COUNT(*)::bigint AS count FROM webhook_events WHERE status = 'PROCESSED'"),
    query<{ count: number }>("SELECT COUNT(*)::bigint AS count FROM webhook_events WHERE status = 'DEAD_LETTERED'"),
    query<{ count: number }>('SELECT COUNT(*)::bigint AS count FROM processed_results'),
    query<{ event_id: string }>(
      `SELECT e.event_id FROM webhook_events e
        LEFT JOIN processed_results r ON r.event_id = e.event_id
        WHERE e.status = 'PROCESSED' AND r.event_id IS NULL`,
    ),
    query<{ event_id: string }>(
      `SELECT e.event_id FROM webhook_events e
         JOIN processed_results r ON r.event_id = e.event_id
        WHERE e.status = 'DEAD_LETTERED'`,
    ),
    query<{ event_id: string; count: number }>(
      `SELECT event_id, COUNT(*)::bigint AS count FROM webhook_attempts
        WHERE source = 'RECOVERY' GROUP BY event_id`,
    ),
    query<{ source: string; status: string; count: number }>(
      'SELECT source, status, COUNT(*)::bigint AS count FROM webhook_attempts GROUP BY source, status',
    ),
    query<{ deliveries: number }>('SELECT COALESCE(SUM(delivery_count),0)::bigint AS deliveries FROM webhook_events'),
  ]);

  const uniqueEvents = num(q1.rows[0]?.unique_event_ids);
  const eventRows = num(q1.rows[0]?.event_rows);
  const processed = num(processedCount.rows[0]?.count);
  const deadLettered = num(deadCount.rows[0]?.count);
  const effects = num(resultCount.rows[0]?.count);
  const totalDeliveries = num(deliverySum.rows[0]?.deliveries);
  const securityByReason: Record<string, number> = {};
  for (const r of q7security.rows) securityByReason[r.reason] = num(r.count);
  const totalRejected = Object.values(securityByReason).reduce((a, b) => a + b, 0);

  // ---- reconciliation against the manifest --------------------------------
  const expectedById = new Map(manifest.logicalEvents.map((e) => [e.eventId, e]));
  const { rows: dbEvents } = await query<{ event_id: string; status: string; processing_attempts: number; delivery_count: number }>(
    'SELECT event_id, status, processing_attempts, delivery_count FROM webhook_events',
  );
  const dbById = new Map(dbEvents.map((e) => [e.event_id, e]));

  const missing: string[] = [];
  const wrongTerminalState: string[] = [];
  const insufficientAttempts: string[] = [];
  for (const expected of manifest.logicalEvents) {
    const row = dbById.get(expected.eventId);
    if (!row) {
      missing.push(expected.eventId);
      continue;
    }
    if (row.status !== expected.expectedTerminalStatus) {
      wrongTerminalState.push(`${expected.eventId} (${row.status} != ${expected.expectedTerminalStatus})`);
    }
    if (row.processing_attempts < expected.minAttempts) {
      insufficientAttempts.push(`${expected.eventId} (${row.processing_attempts} < ${expected.minAttempts})`);
    }
  }
  const unexpectedExtras = dbEvents.filter((e) => !expectedById.has(e.event_id)).map((e) => e.event_id);

  const transientEvents = manifest.logicalEvents.filter((e) => e.category === 'transient-failure');
  const permanentEvents = manifest.logicalEvents.filter((e) => e.category === 'permanent-failure');
  const deadLetterIds = new Set(q5.rows.map((r) => r.original_event_id));
  const retriedIds = new Set(q6.rows.map((r) => r.event_id));

  const stormRow = storm.rows[0];
  const duplicatePlanned = manifest.logicalEvents.filter((e) => e.deliveries > 1);
  const duplicateWithExtraEffects = dupDeliveries.rows.filter((r) => num(r.effects) > 1);

  const recoveredCount = recoveryRows.rows.length;
  const unexplained = uniqueEvents - processed - deadLettered;

  // ---- checks -------------------------------------------------------------
  const checks: Check[] = [
    {
      name: 'Q1  Unique events received',
      expected: `${manifest.counts.logicalEvents}`,
      actual: `${uniqueEvents}`,
      pass: uniqueEvents === manifest.counts.logicalEvents,
      detail: `${totalDeliveries} total deliveries collapsed into ${uniqueEvents} rows`,
    },
    {
      name: 'Q1b No duplicate event rows',
      expected: 'event_rows == unique_event_ids',
      actual: `${eventRows} == ${uniqueEvents}`,
      pass: eventRows === uniqueEvents,
    },
    {
      name: 'Q2  Duplicate business effects',
      expected: '0 rows',
      actual: `${q2.rows.length} rows`,
      pass: q2.rows.length === 0,
      detail: q2.rows.map((r) => `${r.event_id}:${r.effects}`).join(', ') || undefined,
    },
    {
      name: 'Q3  Expected vs actual reconciliation',
      expected: '0 unexplained events',
      actual: `${unexplained} unexplained (${processed} processed + ${deadLettered} dead-lettered of ${uniqueEvents})`,
      pass: unexplained === 0 && missing.length === 0 && wrongTerminalState.length === 0,
      detail:
        [
          missing.length ? `missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}` : '',
          wrongTerminalState.length
            ? `wrong state: ${wrongTerminalState.slice(0, 5).join(', ')}${wrongTerminalState.length > 5 ? '…' : ''}`
            : '',
        ]
          .filter(Boolean)
          .join(' | ') || undefined,
    },
    {
      name: 'Q3b No unexpected events in the inbox',
      expected: '0 extras',
      actual: `${unexpectedExtras.length}`,
      pass: unexpectedExtras.length === 0,
      detail: unexpectedExtras.slice(0, 5).join(', ') || undefined,
    },
    {
      name: 'Q4  Lost / stranded events',
      expected: '0 rows in a non-terminal status',
      actual: `${q4.rows.length} rows`,
      pass: q4.rows.length === 0,
      detail: q4.rows.map((r) => `${r.event_id}:${r.status}`).slice(0, 5).join(', ') || undefined,
    },
    {
      name: 'Q5  Dead-letter store holds the permanent failure',
      expected: permanentEvents.map((e) => e.eventId).join(', ') || 'n/a',
      actual: [...deadLetterIds].join(', ') || 'none',
      pass:
        permanentEvents.every((e) => deadLetterIds.has(e.eventId)) &&
        deadLetterIds.size === permanentEvents.length &&
        deadLettered === permanentEvents.length,
    },
    {
      name: 'Q6  Temporary failures were retried',
      expected: `${transientEvents.length} events with attempts >= 3, all PROCESSED`,
      actual: `${transientEvents.filter((e) => retriedIds.has(e.eventId)).length} retried, ${insufficientAttempts.length} below expectation`,
      pass: transientEvents.every((e) => retriedIds.has(e.eventId)) && insufficientAttempts.length === 0,
      detail: insufficientAttempts.slice(0, 5).join(', ') || undefined,
    },
    {
      name: 'Q7  Invalid-signature events accepted',
      expected: '0',
      actual: `${num(q7accepted.rows[0]?.count)}`,
      pass: num(q7accepted.rows[0]?.count) === 0,
      detail: `${totalRejected} requests rejected: ${JSON.stringify(securityByReason)}`,
    },
    {
      name: 'Q7b Rejected requests were logged',
      expected: `>= ${manifest.counts.totalInvalidDeliveries}`,
      actual: `${totalRejected}`,
      pass: totalRejected >= manifest.counts.totalInvalidDeliveries,
    },
    {
      // The receiver can legitimately record MORE than 50 deliveries: if the
      // crash window overlaps the storm, the sender retries requests whose
      // response was lost. What must never move is the number of event rows
      // (1) and the number of business effects (1).
      name: 'Q8  Retry storm collapsed to one effect',
      expected: `>= ${manifest.storm.deliveries} deliveries -> 1 event row, exactly 1 effect`,
      actual: stormRow
        ? `${stormRow.delivery_count} deliveries -> 1 event row, ${num(stormRow.effects)} effect(s), status ${stormRow.status}`
        : 'storm event missing',
      pass:
        Boolean(stormRow) &&
        num(stormRow?.delivery_count) >= manifest.storm.deliveries &&
        num(stormRow?.effects) === 1 &&
        stormRow?.status === 'PROCESSED',
      detail: manifest.storm.requestsIssued
        ? `${manifest.storm.requestsIssued} HTTP requests issued by the sender (incl. retries) in ${manifest.storm.durationMs}ms`
        : undefined,
    },
    {
      name: 'Q9  Deliberate duplicates -> one effect each',
      expected: `${duplicatePlanned.length} duplicated events, 1 effect each`,
      actual: `${dupDeliveries.rows.length} events had >1 delivery, ${duplicateWithExtraEffects.length} with >1 effect`,
      pass: duplicateWithExtraEffects.length === 0 && dupDeliveries.rows.length >= duplicatePlanned.length,
    },
    {
      name: 'Q11 PROCESSED events all have a business effect',
      expected: '0 mismatches',
      actual: `${processedWithoutResult.rows.length}`,
      pass: processedWithoutResult.rows.length === 0,
    },
    {
      name: 'Q12 Dead-lettered events have NO business effect',
      expected: '0 rows',
      actual: `${deadWithResult.rows.length}`,
      pass: deadWithResult.rows.length === 0,
    },
    {
      name: 'Business effects == processed events',
      expected: `${processed}`,
      actual: `${effects}`,
      pass: effects === processed,
    },
    {
      // A perfectly ordered stream scores 0; a uniformly shuffled one scores
      // ~50% of all pairs. Anything above 30% is unambiguously out of order.
      name: 'Out-of-order delivery actually happened',
      expected: '> 30% of sampled sequence pairs inverted',
      actual: `${manifest.outOfOrder.inversions}/${manifest.outOfOrder.maxInversions} inversions (${(manifest.outOfOrder.ratio * 100).toFixed(1)}%)`,
      pass: manifest.outOfOrder.ratio > 0.3,
    },
    {
      name: 'Processing settled (no in-flight work left)',
      expected: 'stable',
      actual: stabilised.stable ? `stable after ${stabilised.waitedMs}ms` : `TIMED OUT after ${stabilised.waitedMs}ms`,
      pass: stabilised.stable,
    },
  ];

  if (manifest.crash.triggered) {
    checks.push({
      name: 'Crash recovery',
      expected: 'receiver killed mid-flight, recovered, no data loss',
      actual: `killed after ${manifest.crash.triggeredAtDelivery} deliveries, back in ${manifest.crash.downtimeMs}ms, ${recoveredCount} interrupted event(s) reclaimed`,
      pass:
        manifest.crash.downtimeMs > 0 &&
        missing.length === 0 &&
        unexplained === 0 &&
        q2.rows.length === 0,
    });
  }

  // ---- report -------------------------------------------------------------
  const line = '='.repeat(62);
  const out: string[] = [];
  out.push('');
  out.push(line);
  out.push('WEBHOOK HOSTILITY TEST REPORT');
  out.push(line);
  out.push('');
  const pad = (label: string, value: string | number): string => `${label.padEnd(36, ' ')}${value}`;
  out.push(pad('Logical Valid Events Expected:', manifest.counts.logicalEvents));
  out.push(pad('Total HTTP Deliveries Sent:', manifest.counts.totalValidDeliveries + manifest.counts.totalInvalidDeliveries));
  out.push(pad('Unique Events Received:', uniqueEvents));
  out.push(pad('Deliveries Recorded (incl. dupes):', totalDeliveries));
  out.push(pad('Successfully Processed:', processed));
  out.push(pad('Business Effects (processed_results):', effects));
  out.push(pad('Dead Letter Events:', deadLettered));
  out.push(pad('Duplicate Business Effects:', q2.rows.length));
  out.push(pad('Unexplained/Lost Events:', unexplained));
  out.push(pad('Invalid Signature Events Accepted:', num(q7accepted.rows[0]?.count)));
  out.push(pad('Rejected Requests Logged:', totalRejected));
  out.push(
    pad(
      'Retry Storm:',
      stormRow
        ? `${stormRow.delivery_count} deliveries -> 1 event row -> ${num(stormRow.effects)} business effect`
        : 'missing',
    ),
  );
  out.push(pad('Events Retried (attempts > 1):', q6.rows.length));
  out.push(pad('Crash Recovery:', manifest.crash.triggered ? (checks.find((c) => c.name === 'Crash recovery')?.pass ? 'PASS' : 'FAIL') : 'not exercised'));
  out.push('');
  out.push('-'.repeat(62));
  out.push('CHECKS');
  out.push('-'.repeat(62));
  for (const c of checks) {
    out.push(`${c.pass ? ' PASS ' : ' FAIL '} ${c.name}`);
    out.push(`        expected: ${c.expected}`);
    out.push(`        actual  : ${c.actual}`);
    if (c.detail) out.push(`        detail  : ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.pass);
  out.push('');
  out.push(line);
  out.push(`OVERALL RESULT: ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length} check(s) failed)`}`);
  out.push(line);
  out.push('');

  console.log(out.join('\n'));

  // Supporting detail
  console.log('Attempt ledger (webhook_attempts):');
  for (const r of attemptsAgg.rows.sort((a, b) => a.source.localeCompare(b.source))) {
    console.log(`  ${r.source.padEnd(12)} ${r.status.padEnd(30)} ${num(r.count)}`);
  }
  if (q5.rows.length) {
    console.log('\nDead-letter contents:');
    for (const r of q5.rows) {
      console.log(`  ${r.original_event_id} after ${r.total_attempts} attempts -- ${r.failure_reason.slice(0, 80)}`);
    }
  }
  if (q6.rows.length) {
    console.log('\nRetried events (top 12):');
    for (const r of q6.rows.slice(0, 12)) {
      console.log(`  ${r.event_id.padEnd(18)} attempts=${r.processing_attempts} status=${r.status}`);
    }
  }
  console.log('');

  await closePool();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\nVerification failed to run:', err);
  await closePool().catch(() => undefined);
  process.exit(1);
});
