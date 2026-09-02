import type { PoolClient } from 'pg';
import { db } from '../db/pool.js';
import type { ProcessedResultRow } from '../types/events.js';

/**
 * Writes THE business effect. UNIQUE(event_id) + ON CONFLICT DO NOTHING means a
 * second attempt at the same event can never produce a second effect, no matter
 * how the first attempt died.
 *
 * @returns true if this call created the effect, false if it already existed.
 */
export async function insertProcessedResult(
  params: {
    eventId: string;
    resultType: string;
    processedData: Record<string, unknown>;
    attemptNumber: number;
  },
  client: PoolClient,
): Promise<boolean> {
  const { rowCount } = await db(client).query(
    `INSERT INTO processed_results (event_id, result_type, processed_data, attempt_number)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (event_id) DO NOTHING`,
    [params.eventId, params.resultType, JSON.stringify(params.processedData), params.attemptNumber],
  );
  return (rowCount ?? 0) > 0;
}

export async function getProcessedResult(
  eventId: string,
  client?: PoolClient,
): Promise<ProcessedResultRow | null> {
  const { rows } = await db(client).query<ProcessedResultRow>(
    'SELECT * FROM processed_results WHERE event_id = $1',
    [eventId],
  );
  return rows[0] ?? null;
}
