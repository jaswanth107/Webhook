import type { PoolClient } from 'pg';
import { db } from '../db/pool.js';
import type { EventStatus, WebhookEventPayload, WebhookEventRow } from '../types/events.js';

export interface UpsertResult {
  row: WebhookEventRow;
  /** true when this HTTP delivery created the row; false when it was a duplicate delivery. */
  inserted: boolean;
}

/**
 * Idempotent inbox write. A single atomic statement:
 *  - first delivery      -> INSERT, returns inserted = true
 *  - duplicate delivery  -> bumps delivery_count, returns inserted = false
 *
 * `xmax = 0` is Postgres' way of telling us the returned tuple came from the
 * INSERT branch rather than the UPDATE branch. Because this is one statement,
 * 50 concurrent deliveries of the same eventId are resolved by the UNIQUE index
 * itself -- exactly one of them can win the insert.
 */
export async function upsertEvent(
  payload: WebhookEventPayload,
  client?: PoolClient,
): Promise<UpsertResult> {
  const { rows } = await db(client).query<WebhookEventRow & { inserted: boolean }>(
    `
    INSERT INTO webhook_events (event_id, event_type, sequence, event_timestamp, payload, status)
    VALUES ($1, $2, $3, $4, $5::jsonb, 'RECEIVED')
    ON CONFLICT (event_id) DO UPDATE
       SET delivery_count   = webhook_events.delivery_count + 1,
           last_delivery_at = now()
    RETURNING *, (xmax = 0) AS inserted
    `,
    [
      payload.eventId,
      payload.eventType,
      payload.sequence,
      payload.timestamp,
      JSON.stringify(payload),
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('upsertEvent returned no row');
  const { inserted, ...event } = row;
  return { row: event as WebhookEventRow, inserted };
}

/**
 * Atomically claims a batch of due events for this worker.
 *
 * FOR UPDATE SKIP LOCKED makes the claim safe across concurrent workers and
 * across processes: two workers can never claim the same row. The attempt
 * counter is incremented at CLAIM time (not at success/failure time) so that a
 * process which is killed mid-processing still burns an attempt -- a poison
 * event that crashes the receiver cannot loop forever.
 */
export async function claimDueEvents(limit: number, client?: PoolClient): Promise<WebhookEventRow[]> {
  const { rows } = await db(client).query<WebhookEventRow>(
    `
    UPDATE webhook_events e
       SET status                = 'PROCESSING',
           processing_started_at = now(),
           processing_attempts   = e.processing_attempts + 1
      FROM (
        SELECT id
          FROM webhook_events
         WHERE (status = 'RECEIVED')
            OR (status = 'RETRY_PENDING' AND next_retry_at IS NOT NULL AND next_retry_at <= now())
         ORDER BY received_at, id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      ) due
     WHERE e.id = due.id
    RETURNING e.*
    `,
    [limit],
  );
  return rows;
}

/** Locks a single event row for the duration of the caller's transaction. */
export async function lockEvent(eventId: string, client: PoolClient): Promise<WebhookEventRow | null> {
  const { rows } = await db(client).query<WebhookEventRow>(
    'SELECT * FROM webhook_events WHERE event_id = $1 FOR UPDATE',
    [eventId],
  );
  return rows[0] ?? null;
}

export async function markProcessed(eventId: string, client: PoolClient): Promise<void> {
  await db(client).query(
    `
    UPDATE webhook_events
       SET status = 'PROCESSED',
           processed_at = now(),
           processing_started_at = NULL,
           next_retry_at = NULL,
           last_error = NULL
     WHERE event_id = $1
    `,
    [eventId],
  );
}

export async function scheduleRetry(
  eventId: string,
  nextRetryAt: Date,
  lastError: string,
  client?: PoolClient,
): Promise<void> {
  await db(client).query(
    `
    UPDATE webhook_events
       SET status = 'RETRY_PENDING',
           next_retry_at = $2,
           last_error = $3,
           processing_started_at = NULL
     WHERE event_id = $1
       AND status <> 'PROCESSED'
       AND status <> 'DEAD_LETTERED'
    `,
    [eventId, nextRetryAt.toISOString(), lastError.slice(0, 2000)],
  );
}

export async function markDeadLettered(eventId: string, lastError: string, client: PoolClient): Promise<void> {
  await db(client).query(
    `
    UPDATE webhook_events
       SET status = 'DEAD_LETTERED',
           next_retry_at = NULL,
           processing_started_at = NULL,
           last_error = $2
     WHERE event_id = $1
       AND status <> 'PROCESSED'
    `,
    [eventId, lastError.slice(0, 2000)],
  );
}

/**
 * Lease reaper. Any event left in PROCESSING by a crashed process (or a hung
 * one) is returned to the retry queue once its lease expires.
 */
export async function reclaimStaleProcessing(
  timeoutSeconds: number,
  client?: PoolClient,
): Promise<WebhookEventRow[]> {
  const { rows } = await db(client).query<WebhookEventRow>(
    `
    UPDATE webhook_events
       SET status = 'RETRY_PENDING',
           next_retry_at = now(),
           processing_started_at = NULL,
           last_error = COALESCE(last_error, 'Processing lease expired (worker crashed or stalled)')
     WHERE status = 'PROCESSING'
       AND processing_started_at < now() - make_interval(secs => $1::double precision)
    RETURNING *
    `,
    [timeoutSeconds],
  );
  return rows;
}

/** Startup recovery for a single-instance deployment: reclaim every PROCESSING row now. */
export async function reclaimAllProcessing(client?: PoolClient): Promise<WebhookEventRow[]> {
  const { rows } = await db(client).query<WebhookEventRow>(
    `
    UPDATE webhook_events
       SET status = 'RETRY_PENDING',
           next_retry_at = now(),
           processing_started_at = NULL,
           last_error = COALESCE(last_error, 'Interrupted by receiver restart')
     WHERE status = 'PROCESSING'
    RETURNING *
    `,
  );
  return rows;
}

/** Events left in a non-terminal state -- used by recovery logging and health. */
export async function countByStatus(client?: PoolClient): Promise<Record<EventStatus, number>> {
  const { rows } = await db(client).query<{ status: EventStatus; count: number }>(
    'SELECT status, COUNT(*)::bigint AS count FROM webhook_events GROUP BY status',
  );
  const base: Record<EventStatus, number> = {
    RECEIVED: 0,
    PROCESSING: 0,
    PROCESSED: 0,
    RETRY_PENDING: 0,
    FAILED: 0,
    DEAD_LETTERED: 0,
  };
  for (const r of rows) base[r.status] = Number(r.count);
  return base;
}

export async function getEvent(eventId: string, client?: PoolClient): Promise<WebhookEventRow | null> {
  const { rows } = await db(client).query<WebhookEventRow>(
    'SELECT * FROM webhook_events WHERE event_id = $1',
    [eventId],
  );
  return rows[0] ?? null;
}

export interface ListEventsFilter {
  status?: EventStatus;
  eventId?: string;
  eventType?: string;
  page: number;
  limit: number;
}

export async function listEvents(
  filter: ListEventsFilter,
  client?: PoolClient,
): Promise<{ rows: WebhookEventRow[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.status) {
    params.push(filter.status);
    where.push(`status = $${params.length}`);
  }
  if (filter.eventId) {
    params.push(`%${filter.eventId}%`);
    where.push(`event_id ILIKE $${params.length}`);
  }
  if (filter.eventType) {
    params.push(filter.eventType);
    where.push(`event_type = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (filter.page - 1) * filter.limit;
  // Bound as parameters like every other value in this file. The controller's
  // schema already coerces both to integers, but the safety belongs next to
  // the SQL rather than a layer away from it.
  const pageParams = [...params, filter.limit, offset];
  const limitPlaceholder = `$${params.length + 1}`;
  const offsetPlaceholder = `$${params.length + 2}`;

  const conn = db(client);
  const [{ rows: countRows }, { rows }] = await Promise.all([
    conn.query<{ total: number }>(`SELECT COUNT(*)::bigint AS total FROM webhook_events ${whereSql}`, params),
    conn.query<WebhookEventRow>(
      `SELECT * FROM webhook_events ${whereSql} ORDER BY received_at DESC, id DESC LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
      pageParams,
    ),
  ]);
  return { rows, total: Number(countRows[0]?.total ?? 0) };
}

/** Re-queues a dead-lettered event for another processing run (admin replay). */
export async function requeueFromDeadLetter(eventId: string, client: PoolClient): Promise<boolean> {
  const { rowCount } = await db(client).query(
    `
    UPDATE webhook_events
       SET status = 'RETRY_PENDING',
           next_retry_at = now(),
           processing_attempts = 0,
           processing_started_at = NULL,
           last_error = NULL
     WHERE event_id = $1
       AND status = 'DEAD_LETTERED'
    `,
    [eventId],
  );
  return (rowCount ?? 0) > 0;
}
