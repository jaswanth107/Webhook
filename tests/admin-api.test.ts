import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventWorker } from '../server/src/workers/eventWorker.js';
import { getApp, makeEvent, post, query, shutdown, truncateAll } from './helpers.js';

const worker = new EventWorker();

describe('Admin API and health', () => {
  before(async () => {
    await getApp();
  });
  beforeEach(truncateAll);
  after(shutdown);

  it('reports health', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'ok');
    assert.equal(res.json().database, 'up');
  });

  it('lists events with status filter and pagination', async () => {
    for (let i = 0; i < 7; i++) await post(makeEvent({ eventId: `evt_admin_${i}`, sequence: i }));
    await worker.tick();
    await post(makeEvent({ eventId: 'evt_admin_new', sequence: 99 }));

    const app = await getApp();
    const processed = await app.inject({ method: 'GET', url: '/admin/events?status=PROCESSED&limit=5&page=1' });
    assert.equal(processed.statusCode, 200);
    assert.equal(processed.json().data.length, 5);
    assert.equal(processed.json().pagination.total, 7);
    assert.equal(processed.json().pagination.pages, 2);

    const received = await app.inject({ method: 'GET', url: '/admin/events?status=RECEIVED' });
    assert.equal(received.json().data.length, 1);
    assert.equal(received.json().data[0].event_id, 'evt_admin_new');

    const byId = await app.inject({ method: 'GET', url: '/admin/events?eventId=evt_admin_3' });
    assert.equal(byId.json().data.length, 1);

    const bad = await app.inject({ method: 'GET', url: '/admin/events?status=NOPE' });
    assert.equal(bad.statusCode, 400);
  });

  it('returns full event detail including attempts and the business effect', async () => {
    const body = makeEvent({ eventId: 'evt_detail' });
    await post(body);
    await post(body); // duplicate delivery
    await worker.tick();

    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/admin/events/evt_detail' });
    assert.equal(res.statusCode, 200);
    const { event, attempts, processedResult, duplicateDeliveries } = res.json().data;
    assert.equal(event.event_id, 'evt_detail');
    assert.equal(event.status, 'PROCESSED');
    assert.equal(duplicateDeliveries, 1);
    assert.equal(processedResult.event_id, 'evt_detail');
    assert.ok(attempts.length >= 3, 'two deliveries and one processing attempt are recorded');

    const missing = await app.inject({ method: 'GET', url: '/admin/events/evt_nope' });
    assert.equal(missing.statusCode, 404);
  });

  it('exposes stats and integrity counters', async () => {
    await post(makeEvent({ eventId: 'evt_stats_1' }));
    await post(makeEvent({ eventId: 'evt_stats_1' }));
    await post(makeEvent({ eventId: 'evt_stats_2' }), { signature: null });
    await worker.tick();

    const app = await getApp();
    const stats = (await app.inject({ method: 'GET', url: '/admin/stats' })).json().data;
    assert.equal(stats.totalEventsReceived, 1);
    assert.equal(stats.totalDeliveries, 2);
    assert.equal(stats.duplicateDeliveries, 1);
    assert.equal(stats.missingSignatureAttempts, 1);
    assert.equal(stats.byStatus.PROCESSED, 1);

    const integrity = (await app.inject({ method: 'GET', url: '/admin/integrity' })).json().data;
    assert.equal(integrity.duplicateBusinessEffects, 0);
    assert.equal(integrity.processedWithoutResult, 0);
  });

  it('lists dead letters and rejects replaying an event that is not dead-lettered', async () => {
    await post(makeEvent({ eventId: 'evt_alive' }));
    await worker.tick();
    const app = await getApp();

    const empty = await app.inject({ method: 'GET', url: '/admin/dead-letters' });
    assert.deepEqual(empty.json().data, []);

    const notDead = await app.inject({ method: 'POST', url: '/admin/dead-letters/evt_alive/retry' });
    assert.equal(notDead.statusCode, 404);
  });

  it('returns a consistent error shape for unknown routes', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/nope' });
    assert.equal(res.statusCode, 404);
    assert.ok(res.json().error);
  });

  it('does not expose chaos endpoints unless CHAOS_ENABLED', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'POST', url: '/admin/chaos/crash' });
    assert.equal(res.statusCode, 404, 'the kill switch must not exist in a normal deployment');
    const { rows } = await query('SELECT 1');
    assert.equal(rows.length, 1);
  });
});
