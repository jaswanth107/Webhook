import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelayMs, nextRetryAt } from '../server/src/services/retryPolicy.js';
import { EventWorker } from '../server/src/workers/eventWorker.js';
import { config, getApp, makeEvent, post, query, shutdown, truncateAll } from './helpers.js';

const worker = new EventWorker();

/** Ticks the worker, making any scheduled retry immediately due in between. */
async function drainWithRetries(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await worker.tick();
    await query("UPDATE webhook_events SET next_retry_at = now() WHERE status = 'RETRY_PENDING'");
  }
}

describe('Retry policy and backoff', () => {
  it('doubles the delay per attempt and honours the cap', () => {
    const opts = { baseDelayMs: 1000, maxDelayMs: 60_000, jitterRatio: 0 };
    assert.equal(backoffDelayMs(1, opts), 1000);
    assert.equal(backoffDelayMs(2, opts), 2000);
    assert.equal(backoffDelayMs(3, opts), 4000);
    assert.equal(backoffDelayMs(4, opts), 8000);
    assert.equal(backoffDelayMs(5, opts), 16000);
    assert.equal(backoffDelayMs(20, opts), 60_000, 'capped at maxDelayMs');
  });

  it('applies jitter within the configured ratio', () => {
    const opts = { baseDelayMs: 1000, maxDelayMs: 60_000, jitterRatio: 0.2 };
    assert.equal(backoffDelayMs(3, opts, () => 0), 3200); // 4000 - 20%
    assert.equal(backoffDelayMs(3, opts, () => 1), 4800); // 4000 + 20%
    assert.equal(backoffDelayMs(3, opts, () => 0.5), 4000);
  });

  it('schedules the next attempt in the future', () => {
    const now = new Date('2026-09-02T10:00:00.000Z');
    const at = nextRetryAt(2, { baseDelayMs: 1000, maxDelayMs: 60_000, jitterRatio: 0 }, now);
    assert.equal(at.toISOString(), '2026-09-02T10:00:02.000Z');
  });
});

describe('Retry behaviour end to end', () => {
  before(async () => {
    await getApp();
  });
  beforeEach(truncateAll);
  after(shutdown);

  it('retries a transient failure and eventually succeeds exactly once', async () => {
    await post(makeEvent({ eventId: 'evt_transient', data: { amount: 10, failUntilAttempt: 3 } }));

    await worker.tick();
    const afterFirst = (await query<{ status: string; processing_attempts: number; next_retry_at: Date | null }>(
      'SELECT status, processing_attempts, next_retry_at FROM webhook_events WHERE event_id = $1',
      ['evt_transient'],
    )).rows[0]!;
    assert.equal(afterFirst.status, 'RETRY_PENDING');
    assert.equal(afterFirst.processing_attempts, 1);
    assert.ok(afterFirst.next_retry_at, 'a retry must be scheduled in the database, not in a timer');

    await drainWithRetries(5);

    const settled = (await query<{ status: string; processing_attempts: number }>(
      'SELECT status, processing_attempts FROM webhook_events WHERE event_id = $1',
      ['evt_transient'],
    )).rows[0]!;
    assert.equal(settled.status, 'PROCESSED');
    assert.equal(settled.processing_attempts, 3, 'failed twice, succeeded on the third attempt');

    const { rows: effects } = await query<{ count: number }>(
      'SELECT COUNT(*)::bigint AS count FROM processed_results WHERE event_id = $1',
      ['evt_transient'],
    );
    assert.equal(Number(effects[0]!.count), 1);

    const { rows: attempts } = await query<{ status: string }>(
      "SELECT status FROM webhook_attempts WHERE event_id = $1 AND source = 'PROCESSING' ORDER BY id",
      ['evt_transient'],
    );
    assert.deepEqual(attempts.map((a) => a.status), ['FAILED', 'FAILED', 'SUCCESS']);
  });

  it('survives a restart with its retry state intact', async () => {
    await post(makeEvent({ eventId: 'evt_retry_restart', data: { amount: 1, failUntilAttempt: 3 } }));
    await worker.tick(); // fails once, schedules a retry

    // A brand new worker instance (as after a process restart) has no memory of
    // the schedule -- it reads it back out of the database.
    const restarted = new EventWorker();
    await query("UPDATE webhook_events SET next_retry_at = now() WHERE status = 'RETRY_PENDING'");
    for (let i = 0; i < 5; i++) {
      await restarted.tick();
      await query("UPDATE webhook_events SET next_retry_at = now() WHERE status = 'RETRY_PENDING'");
    }

    const { rows } = await query<{ status: string; processing_attempts: number }>(
      'SELECT status, processing_attempts FROM webhook_events WHERE event_id = $1',
      ['evt_retry_restart'],
    );
    assert.equal(rows[0]!.status, 'PROCESSED');
    assert.ok(rows[0]!.processing_attempts >= 3);
  });

  it('dead-letters an event that fails every attempt, preserving its payload', async () => {
    await post(makeEvent({ eventId: 'evt_permanent', eventType: 'order.updated', data: { amount: 5, alwaysFail: true } }));
    await drainWithRetries(config().MAX_PROCESSING_ATTEMPTS + 2);

    const { rows } = await query<{ status: string; processing_attempts: number; last_error: string }>(
      'SELECT status, processing_attempts, last_error FROM webhook_events WHERE event_id = $1',
      ['evt_permanent'],
    );
    assert.equal(rows[0]!.status, 'DEAD_LETTERED');
    assert.equal(rows[0]!.processing_attempts, config().MAX_PROCESSING_ATTEMPTS);

    const { rows: dl } = await query<{ original_event_id: string; total_attempts: number; payload: unknown; failure_reason: string }>(
      'SELECT original_event_id, total_attempts, payload, failure_reason FROM dead_letter_events WHERE original_event_id = $1',
      ['evt_permanent'],
    );
    assert.equal(dl.length, 1, 'the event must not be silently discarded');
    assert.equal(dl[0]!.total_attempts, config().MAX_PROCESSING_ATTEMPTS);
    assert.ok(dl[0]!.payload, 'the original payload is preserved');

    const { rows: effects } = await query<{ count: number }>(
      'SELECT COUNT(*)::bigint AS count FROM processed_results WHERE event_id = $1',
      ['evt_permanent'],
    );
    assert.equal(Number(effects[0]!.count), 0, 'a dead-lettered event must have no business effect');
  });

  it('dead-letters a non-retryable failure immediately', async () => {
    await post(makeEvent({ eventId: 'evt_nonretryable', data: { amount: 1, nonRetryable: true } }));
    await worker.tick();
    const { rows } = await query<{ status: string; processing_attempts: number }>(
      'SELECT status, processing_attempts FROM webhook_events WHERE event_id = $1',
      ['evt_nonretryable'],
    );
    assert.equal(rows[0]!.status, 'DEAD_LETTERED');
    assert.equal(rows[0]!.processing_attempts, 1, 'no retry budget is wasted on an unprocessable event');
  });

  it('replays a dead letter without creating a second business effect', async () => {
    await post(makeEvent({ eventId: 'evt_replay', data: { amount: 7, alwaysFail: true } }));
    await drainWithRetries(config().MAX_PROCESSING_ATTEMPTS + 2);

    const app = await getApp();
    const res = await app.inject({ method: 'POST', url: '/admin/dead-letters/evt_replay/retry' });
    assert.equal(res.statusCode, 200);

    // The failure is deterministic, so it dead-letters again -- and there must
    // still be exactly one dead-letter row and zero business effects.
    await drainWithRetries(config().MAX_PROCESSING_ATTEMPTS + 2);
    const { rows: dl } = await query<{ count: number }>(
      'SELECT COUNT(*)::bigint AS count FROM dead_letter_events WHERE original_event_id = $1',
      ['evt_replay'],
    );
    assert.equal(Number(dl[0]!.count), 1);
    const { rows: effects } = await query<{ count: number }>(
      'SELECT COUNT(*)::bigint AS count FROM processed_results WHERE event_id = $1',
      ['evt_replay'],
    );
    assert.equal(Number(effects[0]!.count), 0);
  });
});
