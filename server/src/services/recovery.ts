import { config } from '../config/env.js';
import * as events from '../repositories/eventRepository.js';
import * as attempts from '../repositories/attemptRepository.js';
import { deadLetterEvent } from './processor.js';
import { log } from '../utils/logger.js';
import { query } from '../db/pool.js';
import type { WebhookEventRow } from '../types/events.js';

export interface RecoveryReport {
  reclaimed: number;
  poisoned: number;
  pendingAfterRecovery: number;
}

/**
 * Startup recovery.
 *
 * A killed process leaves events in PROCESSING with an open lease. Nothing else
 * will ever finish them, so on boot we hand them back to the retry queue. Events
 * sitting in RECEIVED or RETRY_PENDING need no repair -- the worker's claim
 * query finds them on its own, which is precisely why retry state lives in the
 * database and not in a setTimeout.
 */
export async function runStartupRecovery(): Promise<RecoveryReport> {
  const cfg = config();
  log.info('RECOVERY_STARTED', {
    strategy: cfg.RECOVER_ALL_PROCESSING_ON_START ? 'reclaim_all_processing' : 'lease_timeout_only',
    processingTimeoutSeconds: cfg.PROCESSING_TIMEOUT_SECONDS,
  });

  const stale = cfg.RECOVER_ALL_PROCESSING_ON_START
    ? await events.reclaimAllProcessing()
    : await events.reclaimStaleProcessing(cfg.PROCESSING_TIMEOUT_SECONDS);

  const poisoned = await handleReclaimed(stale, 'receiver restart');

  const counts = await events.countByStatus();
  const pending = counts.RECEIVED + counts.PROCESSING + counts.RETRY_PENDING + counts.FAILED;

  log.info('RECOVERY_COMPLETED', {
    reclaimed: stale.length,
    deadLetteredAsPoison: poisoned,
    pendingAfterRecovery: pending,
    statusCounts: counts,
  });

  return { reclaimed: stale.length, poisoned, pendingAfterRecovery: pending };
}

/** Periodic lease reaper for a running process (covers stalls, not just crashes). */
export async function reapStaleLeases(): Promise<number> {
  const cfg = config();
  const stale = await events.reclaimStaleProcessing(cfg.PROCESSING_TIMEOUT_SECONDS);
  if (stale.length > 0) await handleReclaimed(stale, 'expired processing lease');
  return stale.length;
}

async function handleReclaimed(rows: WebhookEventRow[], cause: string): Promise<number> {
  const cfg = config();
  let poisoned = 0;

  for (const row of rows) {
    await attempts.recordAttempt({
      eventId: row.event_id,
      attemptNumber: row.processing_attempts,
      source: 'RECOVERY',
      status: 'RECLAIMED',
      errorMessage: `Reclaimed after ${cause}`,
    });

    log.warn('STALE_EVENT_RECOVERED', {
      eventId: row.event_id,
      previousStatus: 'PROCESSING',
      attempts: row.processing_attempts,
      cause,
    });

    // Poison-pill guard: an event that kills the receiver every time it is
    // touched would otherwise crash-loop forever. Interruptions are not counted
    // as processing failures (the event never got a verdict), so they need
    // their own bound.
    const { rows: recoveries } = await query<{ count: number }>(
      `SELECT COUNT(*)::bigint AS count FROM webhook_attempts
        WHERE event_id = $1 AND source = 'RECOVERY'`,
      [row.event_id],
    );
    const recoveryCount = Number(recoveries[0]?.count ?? 0);
    if (recoveryCount > cfg.MAX_PROCESSING_ATTEMPTS) {
      await deadLetterEvent(
        row,
        `Poison event: interrupted the receiver ${recoveryCount} times without completing`,
      );
      poisoned += 1;
    }
  }
  return poisoned;
}
