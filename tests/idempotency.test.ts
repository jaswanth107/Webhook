import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventWorker } from '../server/src/workers/eventWorker.js';
import { getApp, makeEvent, post, query, shutdown, truncateAll } from './helpers.js';

const worker = new EventWorker();

/** Drains the queue by ticking the worker until nothing is due. */
async function drain(maxTicks = 20): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    const claimed = await worker.tick();
    if (claimed === 0) return;
  }
}

describe('Idempotency: one eventId = one business effect', () => {
  before(async () => {
    await getApp();
  });
  beforeEach(truncateAll);
  after(shutdown);

  it('stores the same event only once when delivered twice', async () => {
    const body = makeEvent({ eventId: 'evt_dup_2' });
    const first = await post(body);
    const second = await post(body);

    assert.equal(first.status, 202);
    assert.equal(first.json.status, 'accepted');
    assert.equal(second.status, 200);
    assert.equal(second.json.status, 'duplicate');

    const { rows } = await query<{ count: number; delivery_count: number }>(
      'SELECT COUNT(*)::bigint AS count, MAX(delivery_count) AS delivery_count FROM webhook_events WHERE event_id = $1',
      ['evt_dup_2'],
    );
    assert.equal(Number(rows[0]!.count), 1);
    assert.equal(Number(rows[0]!.delivery_count), 2);
  });

  it('produces exactly one business effect for 50 simultaneous duplicate deliveries', async () => {
    const body = makeEvent({ eventId: 'evt_storm_test' });
    const responses = await Promise.all(Array.from({ length: 50 }, () => post(body)));

    const accepted = responses.filter((r) => r.status === 202);
    const duplicates = responses.filter((r) => r.status === 200);
    assert.equal(accepted.length, 1, 'exactly one delivery may win the insert');
    assert.equal(duplicates.length, 49);
    assert.equal(responses.filter((r) => r.status >= 400).length, 0, 'no unhandled database errors');

    await drain();

    const { rows: events } = await query<{ count: number; delivery_count: number; status: string }>(
      'SELECT COUNT(*)::bigint AS count, MAX(delivery_count) AS delivery_count, MAX(status) AS status FROM webhook_events WHERE event_id = $1',
      ['evt_storm_test'],
    );
    assert.equal(Number(events[0]!.count), 1);
    assert.equal(Number(events[0]!.delivery_count), 50);
    assert.equal(events[0]!.status, 'PROCESSED');

    const { rows: results } = await query<{ count: number }>(
      'SELECT COUNT(*)::bigint AS count FROM processed_results WHERE event_id = $1',
      ['evt_storm_test'],
    );
    assert.equal(Number(results[0]!.count), 1, 'the business effect must happen exactly once');
  });

  it('answers duplicates safely while the original is still being processed', async () => {
    const body = makeEvent({ eventId: 'evt_dup_inflight' });
    await post(body);
    // Simulate "currently processing" by claiming it without finishing.
    await query("UPDATE webhook_events SET status = 'PROCESSING', processing_started_at = now() WHERE event_id = $1", [
      'evt_dup_inflight',
    ]);

    const dup = await post(body);
    assert.equal(dup.status, 200);
    assert.equal(dup.json.eventStatus, 'PROCESSING');

    const { rows } = await query<{ count: number }>(
      'SELECT COUNT(*)::bigint AS count FROM webhook_events WHERE event_id = $1',
      ['evt_dup_inflight'],
    );
    assert.equal(Number(rows[0]!.count), 1);
  });

  it('answers a duplicate that arrives after the event was processed', async () => {
    const body = makeEvent({ eventId: 'evt_dup_after' });
    await post(body);
    await drain();
    const dup = await post(body);
    assert.equal(dup.status, 200);
    assert.equal(dup.json.eventStatus, 'PROCESSED');
    const { rows } = await query<{ count: number }>(
      'SELECT COUNT(*)::bigint AS count FROM processed_results WHERE event_id = $1',
      ['evt_dup_after'],
    );
    assert.equal(Number(rows[0]!.count), 1);
  });

  it('cannot record a second business effect even if processing runs again', async () => {
    const body = makeEvent({ eventId: 'evt_reprocess' });
    await post(body);
    await drain();

    // Force the event back into the queue as if a crash had interrupted it
    // AFTER the effect was committed.
    await query(
      "UPDATE webhook_events SET status = 'RETRY_PENDING', next_retry_at = now(), processed_at = NULL WHERE event_id = $1",
      ['evt_reprocess'],
    );
    await drain();

    const { rows } = await query<{ count: number }>(
      'SELECT COUNT(*)::bigint AS count FROM processed_results WHERE event_id = $1',
      ['evt_reprocess'],
    );
    assert.equal(Number(rows[0]!.count), 1);
    const { rows: status } = await query<{ status: string }>(
      'SELECT status FROM webhook_events WHERE event_id = $1',
      ['evt_reprocess'],
    );
    assert.equal(status[0]!.status, 'PROCESSED');
  });

  it('accepts out-of-order sequences without rejecting later-arriving earlier events', async () => {
    const order = [5, 2, 4, 1, 3];
    for (const seq of order) {
      const res = await post(makeEvent({ eventId: `evt_seq_${seq}`, sequence: seq }));
      assert.equal(res.status, 202, `sequence ${seq} must be accepted on arrival`);
    }
    await drain();
    const { rows } = await query<{ event_id: string; status: string; sequence: number }>(
      "SELECT event_id, status, sequence FROM webhook_events WHERE event_id LIKE 'evt_seq_%' ORDER BY sequence",
    );
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.map((r) => Number(r.sequence)), [1, 2, 3, 4, 5]);
    assert.ok(rows.every((r) => r.status === 'PROCESSED'));
  });

  it('never lets two workers claim the same event', async () => {
    for (let i = 0; i < 20; i++) await post(makeEvent({ eventId: `evt_claim_${i}`, sequence: i }));

    const a = new EventWorker();
    const b = new EventWorker();
    // Both workers race for the same due events.
    await Promise.all([a.tick(), b.tick(), a.tick(), b.tick()]);

    const { rows: dupes } = await query(
      'SELECT event_id FROM processed_results GROUP BY event_id HAVING COUNT(*) > 1',
    );
    assert.equal(dupes.length, 0);
    const { rows: attempts } = await query<{ event_id: string; processing_attempts: number }>(
      "SELECT event_id, processing_attempts FROM webhook_events WHERE event_id LIKE 'evt_claim_%' AND processing_attempts > 1",
    );
    assert.equal(attempts.length, 0, 'an event must be claimed by exactly one worker');
  });
});
