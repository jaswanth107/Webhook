import type { PoolClient } from 'pg';
import { db } from '../db/pool.js';
import type { SecurityRejectionReason } from '../types/events.js';

/**
 * Rejected requests are recorded here and NOWHERE ELSE. Nothing that fails
 * signature verification or schema validation may ever reach webhook_events --
 * verification query 7 asserts that separation.
 */
export async function recordRejection(
  params: {
    reason: SecurityRejectionReason;
    claimedEventId?: string | null;
    signaturePresent: boolean;
    signatureFingerprint?: string | null;
    remoteIp?: string | null;
    detail?: string | null;
  },
  client?: PoolClient,
): Promise<void> {
  await db(client).query(
    `INSERT INTO security_events (reason, claimed_event_id, signature_present, signature_fp, remote_ip, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      params.reason,
      params.claimedEventId ?? null,
      params.signaturePresent,
      params.signatureFingerprint ?? null,
      params.remoteIp ?? null,
      params.detail ? params.detail.slice(0, 1000) : null,
    ],
  );
}

export async function countRejections(client?: PoolClient): Promise<Record<string, number>> {
  const { rows } = await db(client).query<{ reason: string; count: number }>(
    'SELECT reason, COUNT(*)::bigint AS count FROM security_events GROUP BY reason',
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.reason] = Number(r.count);
  return out;
}

export async function listRejections(limit = 100, client?: PoolClient) {
  const { rows } = await db(client).query(
    'SELECT * FROM security_events ORDER BY created_at DESC, id DESC LIMIT $1',
    [limit],
  );
  return rows;
}
