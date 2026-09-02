import { db } from '../db/pool.js';
import type { PoolClient } from 'pg';
import type { EventStatus } from '../types/events.js';

export interface DashboardStats {
  totalEventsReceived: number;
  totalDeliveries: number;
  duplicateDeliveries: number;
  byStatus: Record<EventStatus, number>;
  processedResults: number;
  deadLetters: number;
  eventsWithRetries: number;
  invalidSignatureAttempts: number;
  missingSignatureAttempts: number;
  rejectedPayloads: number;
  securityByReason: Record<string, number>;
  lastEventAt: string | null;
}

export async function getDashboardStats(client?: PoolClient): Promise<DashboardStats> {
  const conn = db(client);
  const [events, statuses, results, dl, retries, security] = await Promise.all([
    conn.query<{ total: number; deliveries: number; last_event_at: Date | null }>(
      `SELECT COUNT(*)::bigint AS total,
              COALESCE(SUM(delivery_count), 0)::bigint AS deliveries,
              MAX(last_delivery_at) AS last_event_at
         FROM webhook_events`,
    ),
    conn.query<{ status: EventStatus; count: number }>(
      'SELECT status, COUNT(*)::bigint AS count FROM webhook_events GROUP BY status',
    ),
    conn.query<{ count: number }>('SELECT COUNT(*)::bigint AS count FROM processed_results'),
    conn.query<{ count: number }>('SELECT COUNT(*)::bigint AS count FROM dead_letter_events'),
    conn.query<{ count: number }>(
      'SELECT COUNT(*)::bigint AS count FROM webhook_events WHERE processing_attempts > 1',
    ),
    conn.query<{ reason: string; count: number }>(
      'SELECT reason, COUNT(*)::bigint AS count FROM security_events GROUP BY reason',
    ),
  ]);

  const byStatus: Record<EventStatus, number> = {
    RECEIVED: 0,
    PROCESSING: 0,
    PROCESSED: 0,
    RETRY_PENDING: 0,
    FAILED: 0,
    DEAD_LETTERED: 0,
  };
  for (const r of statuses.rows) byStatus[r.status] = Number(r.count);

  const securityByReason: Record<string, number> = {};
  for (const r of security.rows) securityByReason[r.reason] = Number(r.count);

  const total = Number(events.rows[0]?.total ?? 0);
  const deliveries = Number(events.rows[0]?.deliveries ?? 0);

  return {
    totalEventsReceived: total,
    totalDeliveries: deliveries,
    duplicateDeliveries: Math.max(0, deliveries - total),
    byStatus,
    processedResults: Number(results.rows[0]?.count ?? 0),
    deadLetters: Number(dl.rows[0]?.count ?? 0),
    eventsWithRetries: Number(retries.rows[0]?.count ?? 0),
    invalidSignatureAttempts:
      (securityByReason.INVALID_SIGNATURE ?? 0) + (securityByReason.MALFORMED_SIGNATURE ?? 0),
    missingSignatureAttempts: securityByReason.MISSING_SIGNATURE ?? 0,
    rejectedPayloads: (securityByReason.INVALID_JSON ?? 0) + (securityByReason.SCHEMA_INVALID ?? 0),
    securityByReason,
    lastEventAt: events.rows[0]?.last_event_at ? new Date(events.rows[0].last_event_at).toISOString() : null,
  };
}
