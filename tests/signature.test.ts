import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeSignature, verifySignature } from '../server/src/services/signature.js';
import { config, getApp, makeEvent, post, query, shutdown, sign, truncateAll } from './helpers.js';

describe('HMAC signature verification', () => {
  before(async () => {
    await getApp();
  });
  beforeEach(truncateAll);
  after(shutdown);

  it('accepts a correctly signed request', async () => {
    const body = makeEvent({ eventId: 'evt_sig_ok' });
    const res = await post(body);
    assert.equal(res.status, 202);
    assert.equal(res.json.status, 'accepted');
  });

  it('rejects a request with no signature header', async () => {
    const body = makeEvent({ eventId: 'evt_sig_missing' });
    const res = await post(body, { signature: null });
    assert.equal(res.status, 401);
    assert.equal(res.json.reason, 'MISSING_SIGNATURE');
    const { rows } = await query('SELECT 1 FROM webhook_events WHERE event_id = $1', ['evt_sig_missing']);
    assert.equal(rows.length, 0, 'unsigned event must never reach the inbox');
  });

  it('rejects a request signed with the wrong secret', async () => {
    const body = makeEvent({ eventId: 'evt_sig_wrong' });
    const res = await post(body, { secret: 'not-the-real-secret' });
    assert.equal(res.status, 401);
    assert.equal(res.json.reason, 'INVALID_SIGNATURE');
    const { rows } = await query('SELECT 1 FROM webhook_events WHERE event_id = $1', ['evt_sig_wrong']);
    assert.equal(rows.length, 0);
  });

  it('rejects a payload modified after signing', async () => {
    const original = makeEvent({ eventId: 'evt_tamper', data: { amount: 100 } });
    const signature = sign(original, config().WEBHOOK_SECRET);
    const tampered = original.replace('"amount":100', '"amount":999999');
    const res = await post(tampered, { signature });
    assert.equal(res.status, 401);
    const { rows } = await query('SELECT 1 FROM webhook_events WHERE event_id = $1', ['evt_tamper']);
    assert.equal(rows.length, 0);
  });

  it('rejects a signature that is not a sha256 hex digest', async () => {
    const res = await post(makeEvent({ eventId: 'evt_sig_malformed' }), { signature: 'obviously-not-a-digest' });
    assert.equal(res.status, 401);
    assert.equal(res.json.reason, 'MALFORMED_SIGNATURE');
  });

  it('accepts the sha256= prefixed form', async () => {
    const body = makeEvent({ eventId: 'evt_sig_prefixed' });
    const res = await post(body, { signature: `sha256=${sign(body, config().WEBHOOK_SECRET)}` });
    assert.equal(res.status, 202);
  });

  it('records every rejection in security_events and nothing in webhook_events', async () => {
    await post(makeEvent({ eventId: 'evt_r1' }), { signature: null });
    await post(makeEvent({ eventId: 'evt_r2' }), { secret: 'wrong' });
    await post('{not json', {});
    const { rows: sec } = await query<{ count: number }>('SELECT COUNT(*)::bigint AS count FROM security_events');
    assert.equal(Number(sec[0]!.count), 3);
    const { rows: events } = await query<{ count: number }>('SELECT COUNT(*)::bigint AS count FROM webhook_events');
    assert.equal(Number(events[0]!.count), 0);
  });

  it('rejects a schema-invalid body even when correctly signed', async () => {
    const body = JSON.stringify({ eventType: 'order.created', sequence: 1, timestamp: new Date().toISOString(), data: {} });
    const res = await post(body);
    assert.equal(res.status, 400);
    assert.equal(res.json.reason, 'SCHEMA_INVALID');
  });

  it('verifySignature is stable for equal digests and rejects near-misses', () => {
    const secret = 'top-secret';
    const body = '{"a":1}';
    const good = computeSignature(body, secret);
    assert.deepEqual(verifySignature(body, good, secret), { ok: true });
    const flipped = `${good.slice(0, 63)}${good.at(-1) === 'a' ? 'b' : 'a'}`;
    assert.equal(verifySignature(body, flipped, secret).ok, false);
    assert.equal(verifySignature(body, undefined, secret).ok, false);
    assert.equal(verifySignature(body, '   ', secret).ok, false);
  });
});
