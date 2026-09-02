import { config } from '../config/env.js';
import { log } from '../utils/logger.js';

export type CrashPoint = 'before_business_effect' | 'after_business_effect_before_commit' | 'after_commit';

/**
 * Controlled, reproducible crash injection.
 *
 * SIGKILL to our own pid is deliberate: it is the most hostile way for a
 * process to die -- no exception handling, no `finally`, no graceful shutdown,
 * no COMMIT. Whatever the database contains at that instant is all that
 * survives, which is exactly the condition the recovery logic must handle.
 */
export function crashIfConfigured(eventId: string, point: CrashPoint): void {
  const cfg = config();
  if (!cfg.SIMULATE_CRASH_EVENT) return;
  if (cfg.SIMULATE_CRASH_EVENT !== eventId) return;
  if (cfg.SIMULATE_CRASH_POINT !== point) return;
  log.error('CHAOS_CRASH', { eventId, point, pid: process.pid });
  hardKill();
}

export function hardKill(): never {
  // Flush what we can, then die uncleanly.
  try {
    process.stdout.write('');
  } catch {
    /* ignore */
  }
  process.kill(process.pid, 'SIGKILL');
  // Unreachable in practice; keeps the return type honest.
  throw new Error('SIGKILL did not terminate the process');
}
