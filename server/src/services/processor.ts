import { config } from '../config/env.js';
import { withTransaction } from '../db/pool.js';
import * as events from '../repositories/eventRepository.js';
import * as attempts from '../repositories/attemptRepository.js';
import * as results from '../repositories/resultRepository.js';
import * as deadLetters from '../repositories/deadLetterRepository.js';
import { applyBusinessEffect, NonRetryableError } from './businessHandler.js';
import { nextRetryAt } from './retryPolicy.js';
import { crashIfConfigured } from './chaos.js';
import { errorMessage, log } from '../utils/logger.js';
import type { WebhookEventRow } from '../types/events.js';

export type ProcessOutcome =
  | { outcome: 'PROCESSED'; effectCreated: boolean }
  | { outcome: 'ALREADY_PROCESSED' }
  | { outcome: 'RETRY_SCHEDULED'; nextRetryAt: Date; error: string }
  | { outcome: 'DEAD_LETTERED'; error: string };

/**
 * Processes one claimed event.
 *
 * TRANSACTION BOUNDARY (the heart of the exactly-once guarantee):
 *
 *   BEGIN
 *     SELECT ... FOR UPDATE          -- serialise against any other worker
 *     if already PROCESSED -> stop   -- duplicate work is a no-op
 *     run business logic             -- may throw
 *     INSERT processed_results       -- UNIQUE(event_id), ON CONFLICT DO NOTHING
 *     UPDATE status = 'PROCESSED'
 *   COMMIT
 *
 * The business effect and the "this event is done" marker commit together or
 * not at all. A crash before COMMIT rolls both back and the event is retried;
 * a crash after COMMIT leaves a consistent, finished event. There is no window
 * in which the effect exists but the event looks unprocessed, or vice versa.
 */
export async function processClaimedEvent(event: WebhookEventRow): Promise<ProcessOutcome> {
  const cfg = config();
  const attemptNumber = event.processing_attempts; // incremented at claim time

  log.info('EVENT_PROCESSING_STARTED', {
    eventId: event.event_id,
    eventType: event.event_type,
    attempt: attemptNumber,
  });

  try {
    const outcome = await withTransaction<ProcessOutcome>(async (tx) => {
      const locked = await events.lockEvent(event.event_id, tx);
      if (!locked) {
        throw new NonRetryableError(`Event ${event.event_id} vanished from the inbox`);
      }
      if (locked.status === 'PROCESSED') {
        return { outcome: 'ALREADY_PROCESSED' };
      }

      crashIfConfigured(event.event_id, 'before_business_effect');

      const effect = await applyBusinessEffect(locked, attemptNumber);

      const effectCreated = await results.insertProcessedResult(
        {
          eventId: locked.event_id,
          resultType: effect.resultType,
          processedData: effect.processedData,
          attemptNumber,
        },
        tx,
      );

      crashIfConfigured(event.event_id, 'after_business_effect_before_commit');

      await events.markProcessed(locked.event_id, tx);
      await attempts.recordAttempt(
        {
          eventId: locked.event_id,
          attemptNumber,
          source: 'PROCESSING',
          status: effectCreated ? 'SUCCESS' : 'SUCCESS_EFFECT_ALREADY_PRESENT',
        },
        tx,
      );

      return { outcome: 'PROCESSED', effectCreated };
    });

    crashIfConfigured(event.event_id, 'after_commit');

    if (outcome.outcome === 'PROCESSED') {
      log.info('EVENT_PROCESSED', {
        eventId: event.event_id,
        attempt: attemptNumber,
        effectCreated: outcome.effectCreated,
      });
    } else {
      log.info('EVENT_PROCESSED', {
        eventId: event.event_id,
        attempt: attemptNumber,
        note: 'already processed by a previous attempt; no duplicate effect',
      });
    }
    return outcome;
  } catch (err) {
    const message = errorMessage(err);
    const nonRetryable = err instanceof NonRetryableError;
    const exhausted = attemptNumber >= cfg.MAX_PROCESSING_ATTEMPTS;

    log.warn('EVENT_PROCESSING_FAILED', {
      eventId: event.event_id,
      attempt: attemptNumber,
      maxAttempts: cfg.MAX_PROCESSING_ATTEMPTS,
      nonRetryable,
      error: message,
    });

    await attempts
      .recordAttempt({
        eventId: event.event_id,
        attemptNumber,
        source: 'PROCESSING',
        status: 'FAILED',
        errorMessage: message,
      })
      .catch(() => undefined);

    if (nonRetryable || exhausted) {
      const reason = nonRetryable
        ? `Non-retryable failure: ${message}`
        : `Exhausted ${cfg.MAX_PROCESSING_ATTEMPTS} processing attempts. Last error: ${message}`;
      await deadLetterEvent(event, reason);
      return { outcome: 'DEAD_LETTERED', error: message };
    }

    const retryAt = nextRetryAt(attemptNumber, {
      baseDelayMs: cfg.RETRY_BASE_DELAY_MS,
      maxDelayMs: cfg.RETRY_MAX_DELAY_MS,
      jitterRatio: cfg.RETRY_JITTER_RATIO,
    });
    await events.scheduleRetry(event.event_id, retryAt, message);
    log.info('RETRY_SCHEDULED', {
      eventId: event.event_id,
      attempt: attemptNumber,
      nextAttempt: attemptNumber + 1,
      nextRetryAt: retryAt.toISOString(),
      delayMs: retryAt.getTime() - Date.now(),
    });
    return { outcome: 'RETRY_SCHEDULED', nextRetryAt: retryAt, error: message };
  }
}

/**
 * Moves an event to the dead-letter store. The copy and the status flip share a
 * transaction so an event can never be marked DEAD_LETTERED without its payload
 * being safely preserved -- nothing is ever silently dropped.
 */
export async function deadLetterEvent(event: WebhookEventRow, reason: string): Promise<void> {
  await withTransaction(async (tx) => {
    const locked = await events.lockEvent(event.event_id, tx);
    if (!locked || locked.status === 'PROCESSED') return;
    await deadLetters.insertDeadLetter(locked, reason, tx);
    await events.markDeadLettered(locked.event_id, reason, tx);
    await attempts.recordAttempt(
      {
        eventId: locked.event_id,
        attemptNumber: locked.processing_attempts,
        source: 'PROCESSING',
        status: 'DEAD_LETTERED',
        errorMessage: reason,
      },
      tx,
    );
  });
  log.error('EVENT_DEAD_LETTERED', {
    eventId: event.event_id,
    eventType: event.event_type,
    attempts: event.processing_attempts,
    reason,
  });
}
