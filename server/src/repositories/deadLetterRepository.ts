import type { PoolClient } from 'pg';
import { db } from '../db/pool.js';
import type { DeadLetterRow, WebhookEventRow } from '../types/events.js';

/**
 * Copies a permanently failed event into the dead-letter store.
 * ON CONFLICT DO NOTHING keeps this idempotent: a replayed-then-failed-again
 * event updates its reason/attempts instead of creating a second row.
 */
export async function insertDeadLetter(
  event: WebhookEventRow,
  failureReason: string,
  client: PoolClient,
): Promise<void> {
  await db(client).query(
    `
    INSERT INTO dead_letter_events (original_event_id, event_type, payload, failure_reason, total_attempts)
    VALUES ($1, $2, $3::jsonb, $4, $5)
    ON CONFLICT (original_event_id) DO UPDATE
       SET failure_reason   = EXCLUDED.failure_reason,
           total_attempts   = EXCLUDED.total_attempts,
           dead_lettered_at = now(),
           replayed_at      = NULL
    `,
    [
      event.event_id,
      event.event_type,
      JSON.stringify(event.payload),
      failureReason.slice(0, 2000),
      event.processing_attempts,
    ],
  );
}

export async function listDeadLetters(client?: PoolClient): Promise<DeadLetterRow[]> {
  const { rows } = await db(client).query<DeadLetterRow>(
    'SELECT * FROM dead_letter_events ORDER BY dead_lettered_at DESC, id DESC',
  );
  return rows;
}

export async function getDeadLetter(eventId: string, client?: PoolClient): Promise<DeadLetterRow | null> {
  const { rows } = await db(client).query<DeadLetterRow>(
    'SELECT * FROM dead_letter_events WHERE original_event_id = $1',
    [eventId],
  );
  return rows[0] ?? null;
}

export async function markDeadLetterReplayed(eventId: string, client: PoolClient): Promise<void> {
  await db(client).query('UPDATE dead_letter_events SET replayed_at = now() WHERE original_event_id = $1', [
    eventId,
  ]);
}
