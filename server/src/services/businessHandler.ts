import { config } from '../config/env.js';
import type { WebhookEventRow } from '../types/events.js';

/** A failure the handler knows can never succeed -> dead-letter immediately. */
export class NonRetryableError extends Error {
  readonly nonRetryable = true;
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

/** A transient failure -> retried with exponential backoff. */
export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientError';
  }
}

export interface BusinessEffect {
  resultType: string;
  processedData: Record<string, unknown>;
}

/**
 * The "business logic" that must happen exactly once per eventId.
 *
 * Deterministic failure injection (only when SIMULATE_FAILURES=true) is driven
 * by fields inside the event payload so the hostility test is reproducible
 * without restarting the receiver:
 *
 *   data.failUntilAttempt = 3  -> fails attempts 1 and 2, succeeds on 3 (transient)
 *   data.alwaysFail = true     -> fails every attempt until dead-lettered
 *   data.nonRetryable = true   -> fails once, dead-lettered immediately
 */
export async function applyBusinessEffect(
  event: WebhookEventRow,
  attemptNumber: number,
): Promise<BusinessEffect> {
  const cfg = config();
  const data = (event.payload?.data ?? {}) as Record<string, unknown>;

  if (cfg.SIMULATE_FAILURES) {
    if (data.nonRetryable === true) {
      throw new NonRetryableError(`Event ${event.event_id} is permanently unprocessable (simulated)`);
    }
    if (data.alwaysFail === true) {
      throw new TransientError(
        `Simulated permanent downstream failure for ${event.event_id} (attempt ${attemptNumber})`,
      );
    }
    const failUntil = typeof data.failUntilAttempt === 'number' ? data.failUntilAttempt : 0;
    if (failUntil > 0 && attemptNumber < failUntil) {
      throw new TransientError(
        `Simulated transient failure for ${event.event_id} (attempt ${attemptNumber} of ${failUntil - 1} failing attempts)`,
      );
    }
  }

  // Real (if small) business validation: an order event must carry a numeric amount.
  if (event.event_type.startsWith('order.')) {
    const amount = data.amount;
    if (amount !== undefined && typeof amount !== 'number') {
      throw new NonRetryableError(`Event ${event.event_id} has a non-numeric amount; cannot be booked`);
    }
  }

  return {
    resultType: `${event.event_type}.processed`,
    processedData: {
      eventId: event.event_id,
      eventType: event.event_type,
      sequence: event.sequence,
      orderId: data.orderId ?? null,
      customerId: data.customerId ?? null,
      amount: typeof data.amount === 'number' ? data.amount : null,
      bookedAt: new Date().toISOString(),
    },
  };
}
