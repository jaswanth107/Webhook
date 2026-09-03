import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Must be set before the app is built: buildApp() reads the config once, and
// an unset ADMIN_API_TOKEN deliberately leaves /admin/* open.
const TOKEN = 'test-admin-token-0123456789abcdef';
process.env.ADMIN_API_TOKEN = TOKEN;
process.env.HEALTH_MAX_BACKLOG = '2';

const { getApp, makeEvent, post, query, shutdown, truncateAll } = await import('./helpers.js');
const { loadEnv, resetConfigCache } = await import('../server/src/config/env.js');

resetConfigCache();

const auth = (headers: Record<string, string> = {}): Record<string, string> => ({
  ...headers,
  'x-admin-token': TOKEN,
});

/** A minimal env that passes schema validation, for the production guards. */
const baseEnv = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  WEBHOOK_SECRET: 'f1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801',
  ...over,
});

describe('Admin API authentication', () => {
  before(async () => {
    await getApp();
  });
  beforeEach(truncateAll);
  after(shutdown);

  it('rejects an admin request with no token', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/admin/stats' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().reason, 'ADMIN_TOKEN_MISSING');
    assert.match(res.headers['www-authenticate'] as string, /Bearer/);
  });

  it('rejects an admin request with the wrong token', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/stats',
      headers: { 'x-admin-token': 'not-the-right-token-at-all!!' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().reason, 'ADMIN_TOKEN_INVALID');
  });

  it('accepts the token as a bearer credential and as x-admin-token', async () => {
    const app = await getApp();
    const bearer = await app.inject({
      method: 'GET',
      url: '/admin/stats',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(bearer.statusCode, 200);

    const header = await app.inject({ method: 'GET', url: '/admin/stats', headers: auth() });
    assert.equal(header.statusCode, 200);
  });

  it('guards the chaos endpoints too', async () => {
    const app = await getApp();
    // CHAOS_ENABLED is false under test, so the route does not exist at all --
    // but the auth hook must answer before the 404, never leaking which
    // admin routes are registered.
    const res = await app.inject({ method: 'POST', url: '/admin/chaos/reset' });
    assert.equal(res.statusCode, 401);
  });

  it('records rejected admin requests in the security audit trail', async () => {
    const app = await getApp();
    await app.inject({ method: 'GET', url: '/admin/events' });
    await app.inject({ method: 'GET', url: '/admin/events', headers: { 'x-admin-token': 'wrong-token-value' } });

    const { rows } = await query<{ reason: string; count: number }>(
      `SELECT reason, COUNT(*)::int AS count FROM security_events
        WHERE reason IN ('ADMIN_TOKEN_MISSING', 'ADMIN_TOKEN_INVALID') GROUP BY reason`,
    );
    const byReason = Object.fromEntries(rows.map((r) => [r.reason, Number(r.count)]));
    assert.equal(byReason.ADMIN_TOKEN_MISSING, 1);
    assert.equal(byReason.ADMIN_TOKEN_INVALID, 1);
  });

  it('never blocks the webhook endpoint, health or metrics', async () => {
    const app = await getApp();
    const delivery = await post(makeEvent({ eventId: 'evt_auth_open' }));
    assert.equal(delivery.status, 202);
    assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/metrics' })).statusCode, 200);
  });
});

describe('Health backlog reporting', () => {
  before(async () => {
    await getApp();
  });
  beforeEach(truncateAll);
  after(shutdown);

  it('is ok with an empty inbox and reports the backlog', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'ok');
    assert.equal(res.json().backlog, 0);
    assert.equal(res.json().backlogThreshold, 2);
  });

  it('degrades to 503 once the backlog passes the threshold', async () => {
    // The worker is disabled under test, so these simply pile up unprocessed --
    // exactly the "accepting but not draining" state SELECT 1 cannot detect.
    for (let i = 0; i < 3; i++) await post(makeEvent({ eventId: `evt_backlog_${i}`, sequence: i }));

    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().status, 'degraded');
    assert.equal(res.json().backlog, 3);
    assert.equal(res.json().database, 'up');
  });
});

describe('Prometheus metrics', () => {
  before(async () => {
    await getApp();
  });
  beforeEach(truncateAll);
  after(shutdown);

  it('exposes the integrity counters in the text exposition format', async () => {
    await post(makeEvent({ eventId: 'evt_metric_1' }));
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/metrics' });

    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /text\/plain/);
    const body = res.body;
    assert.match(body, /# TYPE webhook_events_total counter/);
    assert.match(body, /^webhook_duplicate_effects_total 0$/m);
    assert.match(body, /^webhook_processed_without_effect_total 0$/m);
    assert.match(body, /^webhook_events_total 1$/m);
    assert.match(body, /webhook_events_by_status\{status="RECEIVED"\} 1/);
  });

  it('reports aggregates only -- no payloads leak through the open endpoint', async () => {
    await post(makeEvent({ eventId: 'evt_metric_secret', data: { orderId: 'ORDER-CONFIDENTIAL' } }));
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    assert.ok(!res.body.includes('ORDER-CONFIDENTIAL'));
    assert.ok(!res.body.includes('evt_metric_secret'));
  });
});

describe('Production configuration guards', () => {
  it('accepts a well-formed production configuration', () => {
    assert.doesNotThrow(() =>
      loadEnv(baseEnv({ NODE_ENV: 'production', ADMIN_API_TOKEN: 'a'.repeat(32) })),
    );
  });

  it('refuses to boot in production with the chaos endpoints enabled', () => {
    assert.throws(
      () => loadEnv(baseEnv({ NODE_ENV: 'production', ADMIN_API_TOKEN: 'a'.repeat(32), CHAOS_ENABLED: 'true' })),
      /CHAOS_ENABLED must be false in production/,
    );
  });

  it('refuses to boot in production with simulated failures enabled', () => {
    assert.throws(
      () => loadEnv(baseEnv({ NODE_ENV: 'production', ADMIN_API_TOKEN: 'a'.repeat(32), SIMULATE_FAILURES: 'true' })),
      /SIMULATE_FAILURES must be false in production/,
    );
  });

  it('refuses to boot in production without an admin token', () => {
    assert.throws(() => loadEnv(baseEnv({ NODE_ENV: 'production' })), /ADMIN_API_TOKEN is required in production/);
  });

  it('refuses the placeholder secret from .env.example in production', () => {
    assert.throws(
      () =>
        loadEnv(
          baseEnv({
            NODE_ENV: 'production',
            ADMIN_API_TOKEN: 'a'.repeat(32),
            WEBHOOK_SECRET: 'super-secret-webhook-key-change-me',
          }),
        ),
      /placeholder/,
    );
  });

  it('refuses a short secret in production', () => {
    assert.throws(
      () => loadEnv(baseEnv({ NODE_ENV: 'production', ADMIN_API_TOKEN: 'a'.repeat(32), WEBHOOK_SECRET: 'abcd1234' })),
      /at least 32 characters/,
    );
  });

  it('rejects an admin token that is too short to be worth having', () => {
    assert.throws(() => loadEnv(baseEnv({ ADMIN_API_TOKEN: 'short' })), /at least 16 characters/);
  });

  it('leaves development configurations alone', () => {
    assert.doesNotThrow(() =>
      loadEnv(baseEnv({ NODE_ENV: 'development', CHAOS_ENABLED: 'true', SIMULATE_FAILURES: 'true' })),
    );
  });
});
