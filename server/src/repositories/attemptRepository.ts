import type { PoolClient } from 'pg';
import { db } from '../db/pool.js';
import type { WebhookAttemptRow } from '../types/events.js';

export type AttemptSource = 'DELIVERY' | 'PROCESSING' | 'RECOVERY' | 'ADMIN_REPLAY';

export async function recordAttempt(
  params: {
    eventId: string;
    attemptNumber: number;
    source: AttemptSource;
    status: string;
    errorMessage?: string | null;
  },
  client?: PoolClient,
): Promise<void> {
  await db(client).query(
    `INSERT INTO webhook_attempts (event_id, attempt_number, source, status, error_message)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      params.eventId,
      params.attemptNumber,
      params.source,
      params.status,
      params.errorMessage ? params.errorMessage.slice(0, 2000) : null,
    ],
  );
}

export async function listAttempts(eventId: string, client?: PoolClient): Promise<WebhookAttemptRow[]> {
  const { rows } = await db(client).query<WebhookAttemptRow>(
    'SELECT * FROM webhook_attempts WHERE event_id = $1 ORDER BY attempted_at, id',
    [eventId],
  );
  return rows;
}
