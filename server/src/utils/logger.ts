/**
 * Minimal dependency-free structured logger. Every line is a single JSON object
 * so logs can be grepped/aggregated. Secrets are never logged: signatures are
 * fingerprinted (first 8 hex chars of a SHA-256 of the value) instead of printed.
 */
import { createHash } from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/** Canonical lifecycle event names used across the system. */
export type LifecycleEvent =
  | 'SERVER_STARTED'
  | 'SERVER_STOPPING'
  | 'WEBHOOK_RECEIVED'
  | 'SIGNATURE_VALID'
  | 'SIGNATURE_INVALID'
  | 'SIGNATURE_MISSING'
  | 'PAYLOAD_INVALID'
  | 'EVENT_ACCEPTED'
  | 'DUPLICATE_EVENT'
  | 'EVENT_PROCESSING_STARTED'
  | 'EVENT_PROCESSING_FAILED'
  | 'RETRY_SCHEDULED'
  | 'EVENT_PROCESSED'
  | 'EVENT_DEAD_LETTERED'
  | 'DEAD_LETTER_REPLAYED'
  | 'RECOVERY_STARTED'
  | 'RECOVERY_COMPLETED'
  | 'STALE_EVENT_RECOVERED'
  | 'WORKER_ERROR'
  | 'MIGRATION_APPLIED'
  | 'CHAOS_CRASH'
  | 'CHAOS_RESET';

let currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function fingerprint(value: string | undefined | null): string {
  if (!value) return 'none';
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

function emit(level: Exclude<LogLevel, 'silent'>, event: LifecycleEvent | string, fields: Record<string, unknown> = {}): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[currentLevel]) return;
  const line = JSON.stringify({
    level,
    event,
    ts: new Date().toISOString(),
    ...fields,
  });
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const log = {
  debug: (event: LifecycleEvent | string, fields?: Record<string, unknown>) => emit('debug', event, fields),
  info: (event: LifecycleEvent | string, fields?: Record<string, unknown>) => emit('info', event, fields),
  warn: (event: LifecycleEvent | string, fields?: Record<string, unknown>) => emit('warn', event, fields),
  error: (event: LifecycleEvent | string, fields?: Record<string, unknown>) => emit('error', event, fields),
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
