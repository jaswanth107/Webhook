import type { FastifyInstance } from 'fastify';
import { config } from '../config/env.js';
import { query } from '../db/pool.js';
import { receiveWebhook } from '../controllers/webhookController.js';
import * as admin from '../controllers/adminController.js';
import { hardKill } from '../services/chaos.js';
import { requireAdminAuth } from '../services/adminAuth.js';
import { reapStaleLeases } from '../services/recovery.js';
import { eventWorker } from '../workers/eventWorker.js';
import * as eventsRepo from '../repositories/eventRepository.js';
import { getDashboardStats } from '../repositories/statsRepository.js';
import { log } from '../utils/logger.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  const cfg = config();

  // ---- admin authentication ----------------------------------------------
  // Registered before the routes so it covers every /admin/* path, including
  // the chaos endpoints. No-ops when ADMIN_API_TOKEN is unset (dev default);
  // config validation makes the token mandatory when NODE_ENV=production.
  app.addHook('onRequest', requireAdminAuth);
  if (!cfg.ADMIN_API_TOKEN) {
    log.warn('ADMIN_API_UNPROTECTED', {
      detail: 'ADMIN_API_TOKEN is not set -- /admin/* is open to anyone who can reach this port',
      chaosEnabled: cfg.CHAOS_ENABLED,
    });
  }

  // ---- webhook ------------------------------------------------------------
  app.post('/webhooks/events', receiveWebhook);

  // ---- health -------------------------------------------------------------
  /**
   * Liveness AND readiness. `SELECT 1` alone cannot distinguish a receiver that
   * is draining its inbox from one that is accepting deliveries and processing
   * none, so the backlog is reported and -- past HEALTH_MAX_BACKLOG -- turns
   * the check red. A container that looks healthy while falling behind is the
   * failure mode this endpoint exists to catch.
   */
  app.get('/health', async (_req, reply) => {
    try {
      await query('SELECT 1');
      const counts = await eventsRepo.countByStatus();
      const backlog = counts.RECEIVED + counts.PROCESSING + counts.RETRY_PENDING + counts.FAILED;
      const overloaded = cfg.HEALTH_MAX_BACKLOG > 0 && backlog > cfg.HEALTH_MAX_BACKLOG;
      await reply.code(overloaded ? 503 : 200).send({
        status: overloaded ? 'degraded' : 'ok',
        database: 'up',
        worker: eventWorker.stats,
        backlog,
        backlogThreshold: cfg.HEALTH_MAX_BACKLOG,
        byStatus: counts,
      });
    } catch {
      await reply.code(503).send({ status: 'degraded', database: 'down' });
    }
  });

  // ---- metrics ------------------------------------------------------------
  /**
   * Prometheus text exposition. Deliberately hand-rolled: the numbers all come
   * from the same queries the dashboard uses, so there is no second source of
   * truth to drift, and no scrape-time dependency to keep patched.
   *
   * The integrity counters matter most here -- webhook_duplicate_effects_total
   * and webhook_processed_without_effect_total are the receiver's core promise
   * expressed as something you can alert on.
   */
  app.get('/metrics', async (_req, reply) => {
    const [stats, counts, integrity] = await Promise.all([
      getDashboardStats(),
      eventsRepo.countByStatus(),
      query<{ duplicate_effects: number; processed_without_result: number }>(
        `SELECT
           (SELECT COUNT(*)::bigint FROM (
              SELECT event_id FROM processed_results GROUP BY event_id HAVING COUNT(*) > 1
            ) d) AS duplicate_effects,
           (SELECT COUNT(*)::bigint FROM webhook_events e
             WHERE e.status = 'PROCESSED'
               AND NOT EXISTS (SELECT 1 FROM processed_results r WHERE r.event_id = e.event_id)
           ) AS processed_without_result`,
      ),
    ]);

    const backlog = counts.RECEIVED + counts.PROCESSING + counts.RETRY_PENDING + counts.FAILED;
    const row = integrity.rows[0];
    const lines: string[] = [];
    const metric = (name: string, help: string, type: string, value: number, labels = ''): void => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name}${labels} ${value}`);
    };

    metric('webhook_events_total', 'Unique logical events in the inbox.', 'counter', stats.totalEventsReceived);
    metric('webhook_deliveries_total', 'HTTP deliveries accepted, including duplicates.', 'counter', stats.totalDeliveries);
    metric('webhook_duplicate_deliveries_total', 'Deliveries absorbed as duplicates.', 'counter', stats.duplicateDeliveries);
    metric('webhook_business_effects_total', 'Rows in processed_results.', 'counter', stats.processedResults);
    metric('webhook_dead_letters_total', 'Permanently failed events.', 'counter', stats.deadLetters);
    metric('webhook_events_retried_total', 'Events that needed more than one attempt.', 'counter', stats.eventsWithRetries);
    metric('webhook_rejected_requests_total', 'Requests rejected before reaching the inbox.', 'counter',
      Object.values(stats.securityByReason).reduce((a, b) => a + b, 0));
    metric('webhook_backlog_events', 'Events not yet in a terminal state.', 'gauge', backlog);
    metric('webhook_duplicate_effects_total', 'Events with more than one business effect. MUST be 0.', 'gauge',
      Number(row?.duplicate_effects ?? 0));
    metric('webhook_processed_without_effect_total', 'PROCESSED events with no business effect. MUST be 0.', 'gauge',
      Number(row?.processed_without_result ?? 0));

    lines.push('# HELP webhook_events_by_status Events grouped by status.', '# TYPE webhook_events_by_status gauge');
    for (const [status, count] of Object.entries(counts)) {
      lines.push(`webhook_events_by_status{status="${status}"} ${count}`);
    }
    lines.push('# HELP webhook_rejections_by_reason Rejected requests grouped by reason.',
      '# TYPE webhook_rejections_by_reason gauge');
    for (const [reason, count] of Object.entries(stats.securityByReason)) {
      lines.push(`webhook_rejections_by_reason{reason="${reason}"} ${count}`);
    }
    metric('webhook_worker_running', 'Whether the processing worker loop is alive.', 'gauge',
      eventWorker.stats.running ? 1 : 0);

    await reply.type('text/plain; version=0.0.4; charset=utf-8').send(`${lines.join('\n')}\n`);
  });

  // ---- admin API ----------------------------------------------------------
  app.get('/admin/stats', admin.getStats);
  app.get('/admin/integrity', admin.getIntegrity);
  app.get('/admin/events', admin.listEvents);
  app.get('/admin/events/:eventId', admin.getEventDetail);
  app.get('/admin/dead-letters', admin.listDeadLetters);
  app.post('/admin/dead-letters/:eventId/retry', admin.retryDeadLetter);
  app.get('/admin/security-events', admin.listSecurityEvents);

  // ---- serverless processing tick -----------------------------------------
  /**
   * Runs ONE claim-and-process cycle, then returns.
   *
   * On a normal deployment the worker loop does this continuously and this
   * route is unnecessary. On a platform with no long-lived process (Vercel and
   * friends) there is nothing to run the loop, so an external scheduler calls
   * this instead. It is admin-guarded because it does real work.
   *
   * Safe to call concurrently: claimDueEvents uses FOR UPDATE SKIP LOCKED, so
   * two overlapping ticks can never claim the same event.
   */
  app.post('/admin/tick', async (_request, reply) => {
    const started = Date.now();
    const [claimed, reclaimed] = await Promise.all([eventWorker.tick(), reapStaleLeases()]);
    log.info('WORKER_TICK', { claimed, reclaimed, ms: Date.now() - started });
    await reply.send({
      ok: true,
      data: { claimed, staleReclaimed: reclaimed, ms: Date.now() - started },
    });
  });

  // ---- chaos (test-only) --------------------------------------------------
  if (cfg.CHAOS_ENABLED) {
    /**
     * Kills this process with SIGKILL after replying. Docker/systemd restarts
     * it, and startup recovery has to clean up whatever was in flight.
     */
    app.post('/admin/chaos/crash', async (request, reply) => {
      const delayMs = Number((request.query as { delayMs?: string }).delayMs ?? 50);
      log.error('CHAOS_CRASH', { trigger: 'admin_endpoint', delayMs, pid: process.pid });
      await reply.code(202).send({ status: 'crashing', pid: process.pid, delayMs });
      setTimeout(() => hardKill(), Math.max(0, Math.min(delayMs, 5000)));
    });

    /** Wipes all tables. Used between hostility-test runs. */
    app.post('/admin/chaos/reset', async (_request, reply) => {
      await query(
        'TRUNCATE processed_results, dead_letter_events, webhook_attempts, security_events, webhook_events RESTART IDENTITY CASCADE',
      );
      log.warn('CHAOS_RESET', { tables: 5 });
      await reply.send({ ok: true, data: { reset: true } });
    });
  }
}
