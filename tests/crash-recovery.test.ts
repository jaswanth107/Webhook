import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventWorker } from '../server/src/workers/eventWorker.js';
import { reapStaleLeases, runStartupRecovery } from '../server/src/services/recovery.js';
import { config, getApp, makeEvent, post, query, shutdown, truncateAll } from './helpers.js';

const worker = new EventWorker();

/**
 * A real crash is a SIGKILL, which a test cannot perform on its own process
 * without ending the run. What a crash LEAVES BEHIND in the database is fully
 * reproducible though, and that is what recovery has to cope with:
 *   - an event persisted but never picked up            (status RECEIVED)
 *   - an event claimed but never finished               (status PROCESSING, open lease)
 *   - a business effect committed with a stale status   (effect present, event not PROCESSED)
 * The 1,000-event hostility test additionally performs a genuine SIGKILL.
 */
describe('Crash recovery', () => {
  before(async () => {
    await getApp();
  });
  beforeEach(truncateAll);
  after(shutdown);

  it('processes an event that was persisted just before the process died', async () => {
    await post(makeEvent({ eventId: 'evt_crash_before_processing' }));
    // The receiver dies here: the event is durable, nothing else happened.
    await runStartupRecovery();
    await worker.tick();

    const { rows } = await query<{ status: string }>('SELECT status FROM webhook_events WHERE event_id = $1', [
      'evt_crash_before_processing',
    ]);
    assert.equal(rows[0]!.status, 'PROCESSED');
  });

  it('reclaims events left in PROCESSING and finishes them exactly once', async () => {
    for (let i = 0; i < 5; i++) await post(makeEvent({ eventId: `evt_inflight_${i}`, sequence: i }));
    await query(
      "UPDATE webhook_events SET status = 'PROCESSING', processing_started_at = now(), processing_attempts = 1",
    );

    const report = await runStartupRecovery();
    assert.equal(report.reclaimed, 5);

    const { rows: reclaimed } = await query<{ status: string; next_retry_at: Date }>(
      'SELECT status, next_retry_at FROM webhook_events',
    );
    assert.ok(reclaimed.every((r) => r.status === 'RETRY_PENDING'));

    await worker.tick();
    const { rows: done } = await query<{ status: string; count: number }>(
      'SELECT status, COUNT(*)::bigint AS count FROM webhook_events GROUP BY status',
    );
    assert.deepEqual(done, [{ status: 'PROCESSED', count: 5 }]);

    const { rows: dupes } = await query('SELECT event_id FROM processed_results GROUP BY event_id HAVING COUNT(*) > 1');
    assert.equal(dupes.length, 0);
    const { rows: effects } = await query<{ count: number }>('SELECT COUNT(*)::bigint AS count FROM processed_results');
    assert.equal(Number(effects[0]!.count), 5, 'five events, five effects -- no double counting');
  });

  it('records a RECOVERY audit row for every reclaimed event', async () => {
    await post(makeEvent({ eventId: 'evt_audit' }));
    await query("UPDATE webhook_events SET status = 'PROCESSING', processing_started_at = now()");
    await runStartupRecovery();
    const { rows } = await query<{ status: string; source: string }>(
      "SELECT status, source FROM webhook_attempts WHERE event_id = $1 AND source = 'RECOVERY'",
      ['evt_audit'],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, 'RECLAIMED');
  });

  it('does not double-count when the effect was committed but the status looks unfinished', async () => {
    await post(makeEvent({ eventId: 'evt_effect_committed' }));
    // Business effect exists; the event row was left mid-flight.
    await query(
      `INSERT INTO processed_results (event_id, result_type, processed_data, attempt_number)
       VALUES ($1, 'order.created.processed', '{"replayed":false}'::jsonb, 1)`,
      ['evt_effect_committed'],
    );
    await query(
      "UPDATE webhook_events SET status = 'PROCESSING', processing_started_at = now(), processing_attempts = 1",
    );

    await runStartupRecovery();
    await worker.tick();

    const { rows: effects } = await query<{ count: number }>(
      'SELECT COUNT(*)::bigint AS count FROM processed_results WHERE event_id = $1',
      ['evt_effect_committed'],
    );
    assert.equal(Number(effects[0]!.count), 1, 'the existing effect must not be duplicated');

    const { rows: ev } = await query<{ status: string }>('SELECT status FROM webhook_events WHERE event_id = $1', [
      'evt_effect_committed',
    ]);
    assert.equal(ev[0]!.status, 'PROCESSED');

    const { rows: attempt } = await query<{ status: string }>(
      "SELECT status FROM webhook_attempts WHERE event_id = $1 AND source = 'PROCESSING' ORDER BY id DESC LIMIT 1",
      ['evt_effect_committed'],
    );
    assert.equal(attempt[0]!.status, 'SUCCESS_EFFECT_ALREADY_PRESENT');
  });

  it('reclaims an expired processing lease while the server is running', async () => {
    await post(makeEvent({ eventId: 'evt_stalled' }));
    const timeout = config().PROCESSING_TIMEOUT_SECONDS;
    await query(
      `UPDATE webhook_events
          SET status = 'PROCESSING',
              processing_started_at = now() - make_interval(secs => $1::double precision),
              processing_attempts = 1`,
      [timeout + 5],
    );

    const reaped = await reapStaleLeases();
    assert.equal(reaped, 1);

    const { rows } = await query<{ status: string }>('SELECT status FROM webhook_events WHERE event_id = $1', [
      'evt_stalled',
    ]);
    assert.equal(rows[0]!.status, 'RETRY_PENDING');
  });

  it('leaves a healthy in-flight lease alone', async () => {
    await post(makeEvent({ eventId: 'evt_fresh_lease' }));
    await query("UPDATE webhook_events SET status = 'PROCESSING', processing_started_at = now()");
    const reaped = await reapStaleLeases();
    assert.equal(reaped, 0, 'a lease that has not expired must not be stolen');
  });

  it('dead-letters a poison event that keeps killing the receiver', async () => {
    await post(makeEvent({ eventId: 'evt_poison' }));
    await query("UPDATE webhook_events SET status = 'PROCESSING', processing_started_at = now(), processing_attempts = 1");
    // Five previous interruptions already recorded.
    for (let i = 1; i <= config().MAX_PROCESSING_ATTEMPTS; i++) {
      await query(
        `INSERT INTO webhook_attempts (event_id, attempt_number, source, status, error_message)
         VALUES ($1, $2, 'RECOVERY', 'RECLAIMED', 'previous crash')`,
        ['evt_poison', i],
      );
    }

    const report = await runStartupRecovery();
    assert.equal(report.poisoned, 1);

    const { rows } = await query<{ status: string }>('SELECT status FROM webhook_events WHERE event_id = $1', [
      'evt_poison',
    ]);
    assert.equal(rows[0]!.status, 'DEAD_LETTERED');
    const { rows: dl } = await query('SELECT 1 FROM dead_letter_events WHERE original_event_id = $1', ['evt_poison']);
    assert.equal(dl.length, 1, 'even a poison event is preserved, never dropped');
  });

  it('keeps a duplicate delivery that arrives after a crash safe', async () => {
    const body = makeEvent({ eventId: 'evt_dup_after_crash' });
    await post(body);
    await query("UPDATE webhook_events SET status = 'PROCESSING', processing_started_at = now(), processing_attempts = 1");

    // Sender retries because it never saw a response before the crash.
    const retryDelivery = await post(body);
    assert.equal(retryDelivery.status, 200);
    assert.equal(retryDelivery.json.status, 'duplicate');

    await runStartupRecovery();
    await worker.tick();

    const { rows } = await query<{ count: number }>(
      'SELECT COUNT(*)::bigint AS count FROM processed_results WHERE event_id = $1',
      ['evt_dup_after_crash'],
    );
    assert.equal(Number(rows[0]!.count), 1);
  });
});
