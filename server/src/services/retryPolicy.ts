/**
 * Exponential backoff with full-ratio jitter.
 *
 *   delay(n) = min(base * 2^(n-1), maxDelay)  ± jitterRatio
 *
 * Jitter matters when many events fail at the same instant (e.g. a downstream
 * outage): without it every retry lands in the same millisecond and re-creates
 * the thundering herd that caused the failure.
 */
export interface BackoffOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export function backoffDelayMs(attemptNumber: number, opts: BackoffOptions, random = Math.random): number {
  const n = Math.max(1, Math.floor(attemptNumber));
  const exponent = Math.min(n - 1, 30); // guard against 2^large overflow
  const raw = opts.baseDelayMs * Math.pow(2, exponent);
  const capped = Math.min(raw, opts.maxDelayMs);
  if (opts.jitterRatio <= 0) return Math.round(capped);
  const jitterSpan = capped * opts.jitterRatio;
  const delta = (random() * 2 - 1) * jitterSpan;
  return Math.max(0, Math.round(capped + delta));
}

export function nextRetryAt(attemptNumber: number, opts: BackoffOptions, now = new Date()): Date {
  return new Date(now.getTime() + backoffDelayMs(attemptNumber, opts));
}
