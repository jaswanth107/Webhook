import { config } from '../config/env.js';
import * as events from '../repositories/eventRepository.js';
import { processClaimedEvent } from '../services/processor.js';
import { reapStaleLeases } from '../services/recovery.js';
import { mapWithConcurrency, sleep } from '../utils/concurrency.js';
import { errorMessage, log } from '../utils/logger.js';

/**
 * Database-backed processing worker.
 *
 * There are no in-memory timers holding retry state: every tick asks the
 * database "what is due right now?". That is what makes retries survive a
 * restart -- the schedule lives in webhook_events.next_retry_at, and a fresh
 * process picks up exactly where the dead one left off.
 */
export class EventWorker {
  private running = false;
  private stopping = false;
  private wake: (() => void) | null = null;
  private loopPromise: Promise<void> | null = null;
  private reaperTimer: NodeJS.Timeout | null = null;
  private processedCount = 0;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.loopPromise = this.loop();

    const cfg = config();
    const reapEveryMs = Math.max(1000, (cfg.PROCESSING_TIMEOUT_SECONDS * 1000) / 2);
    this.reaperTimer = setInterval(() => {
      reapStaleLeases().catch((err) => log.error('WORKER_ERROR', { scope: 'reaper', message: errorMessage(err) }));
    }, reapEveryMs);
    this.reaperTimer.unref();
  }

  /** Nudges the loop so a freshly accepted event is processed without waiting for the next poll. */
  notify(): void {
    if (this.wake) {
      const w = this.wake;
      this.wake = null;
      w();
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.notify();
    if (this.reaperTimer) clearInterval(this.reaperTimer);
    this.reaperTimer = null;
    await this.loopPromise?.catch(() => undefined);
    this.running = false;
  }

  get stats(): { running: boolean; processedCount: number } {
    return { running: this.running, processedCount: this.processedCount };
  }

  /** Runs a single claim+process cycle. Exposed for tests, which drive the worker deterministically. */
  async tick(): Promise<number> {
    const cfg = config();
    const claimed = await events.claimDueEvents(cfg.WORKER_BATCH_SIZE);
    if (claimed.length === 0) return 0;

    const outcomes = await mapWithConcurrency(claimed, cfg.WORKER_CONCURRENCY, async (event) =>
      processClaimedEvent(event),
    );
    for (const o of outcomes) {
      if (o.status === 'rejected') {
        log.error('WORKER_ERROR', { scope: 'process', message: errorMessage(o.reason) });
      } else if (o.value.outcome === 'PROCESSED') {
        this.processedCount += 1;
      }
    }
    return claimed.length;
  }

  private async loop(): Promise<void> {
    const cfg = config();
    while (!this.stopping) {
      let claimed = 0;
      try {
        claimed = await this.tick();
      } catch (err) {
        log.error('WORKER_ERROR', { scope: 'loop', message: errorMessage(err) });
        await sleep(cfg.WORKER_POLL_INTERVAL_MS);
        continue;
      }
      // A full batch means there is very likely more work waiting: loop again
      // immediately instead of sleeping. Otherwise wait for a poll interval or
      // for an inbound delivery to wake us.
      if (claimed >= cfg.WORKER_BATCH_SIZE) continue;
      await this.waitForWork(cfg.WORKER_POLL_INTERVAL_MS);
    }
  }

  private waitForWork(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      timer.unref();
      this.wake = done;
    });
  }
}

export const eventWorker = new EventWorker();
