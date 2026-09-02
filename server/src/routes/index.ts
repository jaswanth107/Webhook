import type { FastifyInstance } from 'fastify';
import { config } from '../config/env.js';
import { query } from '../db/pool.js';
import { receiveWebhook } from '../controllers/webhookController.js';
import * as admin from '../controllers/adminController.js';
import { hardKill } from '../services/chaos.js';
import { eventWorker } from '../workers/eventWorker.js';
import { log } from '../utils/logger.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  const cfg = config();

  // ---- webhook ------------------------------------------------------------
  app.post('/webhooks/events', receiveWebhook);

  // ---- health -------------------------------------------------------------
  app.get('/health', async (_req, reply) => {
    try {
      await query('SELECT 1');
      await reply.send({ status: 'ok', database: 'up', worker: eventWorker.stats });
    } catch {
      await reply.code(503).send({ status: 'degraded', database: 'down' });
    }
  });

  // ---- admin API ----------------------------------------------------------
  app.get('/admin/stats', admin.getStats);
  app.get('/admin/integrity', admin.getIntegrity);
  app.get('/admin/events', admin.listEvents);
  app.get('/admin/events/:eventId', admin.getEventDetail);
  app.get('/admin/dead-letters', admin.listDeadLetters);
  app.post('/admin/dead-letters/:eventId/retry', admin.retryDeadLetter);
  app.get('/admin/security-events', admin.listSecurityEvents);

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
