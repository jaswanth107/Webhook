import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTransaction, query } from '../db/pool.js';
import * as eventsRepo from '../repositories/eventRepository.js';
import * as attemptsRepo from '../repositories/attemptRepository.js';
import * as deadLetterRepo from '../repositories/deadLetterRepository.js';
import * as securityRepo from '../repositories/securityRepository.js';
import * as resultRepo from '../repositories/resultRepository.js';
import { getDashboardStats } from '../repositories/statsRepository.js';
import { EVENT_STATUSES } from '../types/events.js';
import { eventWorker } from '../workers/eventWorker.js';
import { log } from '../utils/logger.js';

const ListQuerySchema = z.object({
  status: z.enum(EVENT_STATUSES).optional(),
  eventId: z.string().min(1).max(255).optional(),
  eventType: z.string().min(1).max(255).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export async function getStats(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const stats = await getDashboardStats();
  await reply.send({ ok: true, data: stats });
}

export async function listEvents(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const parsed = ListQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    await reply.code(400).send({ ok: false, error: 'Invalid query parameters', detail: parsed.error.issues });
    return;
  }
  const { rows, total } = await eventsRepo.listEvents(parsed.data);
  await reply.send({
    ok: true,
    data: rows,
    pagination: {
      page: parsed.data.page,
      limit: parsed.data.limit,
      total,
      pages: Math.max(1, Math.ceil(total / parsed.data.limit)),
    },
  });
}

export async function getEventDetail(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { eventId } = request.params as { eventId: string };
  const event = await eventsRepo.getEvent(eventId);
  if (!event) {
    await reply.code(404).send({ ok: false, error: `Unknown eventId ${eventId}` });
    return;
  }
  const [attempts, result, deadLetter] = await Promise.all([
    attemptsRepo.listAttempts(eventId),
    resultRepo.getProcessedResult(eventId),
    deadLetterRepo.getDeadLetter(eventId),
  ]);
  await reply.send({
    ok: true,
    data: {
      event,
      attempts,
      processedResult: result,
      deadLetter,
      deliveryCount: event.delivery_count,
      duplicateDeliveries: Math.max(0, event.delivery_count - 1),
    },
  });
}

export async function listDeadLetters(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const rows = await deadLetterRepo.listDeadLetters();
  await reply.send({ ok: true, data: rows });
}

/**
 * POST /admin/dead-letters/:eventId/retry
 *
 * Replay is idempotent by construction: the event keeps its original eventId,
 * so if a business effect already exists the UNIQUE constraint on
 * processed_results still permits only one.
 */
export async function retryDeadLetter(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { eventId } = request.params as { eventId: string };
  const dead = await deadLetterRepo.getDeadLetter(eventId);
  if (!dead) {
    await reply.code(404).send({ ok: false, error: `No dead-letter record for ${eventId}` });
    return;
  }

  const requeued = await withTransaction(async (tx) => {
    const ok = await eventsRepo.requeueFromDeadLetter(eventId, tx);
    if (ok) {
      await deadLetterRepo.markDeadLetterReplayed(eventId, tx);
      await attemptsRepo.recordAttempt(
        { eventId, attemptNumber: 0, source: 'ADMIN_REPLAY', status: 'REQUEUED' },
        tx,
      );
    }
    return ok;
  });

  if (!requeued) {
    await reply.code(409).send({ ok: false, error: `Event ${eventId} is not in DEAD_LETTERED state` });
    return;
  }
  log.info('DEAD_LETTER_REPLAYED', { eventId });
  eventWorker.notify();
  await reply.send({ ok: true, data: { eventId, status: 'RETRY_PENDING' } });
}

export async function listSecurityEvents(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const limit = Number((request.query as { limit?: string }).limit ?? 100);
  const [rows, counts] = await Promise.all([
    securityRepo.listRejections(Number.isFinite(limit) ? Math.min(limit, 500) : 100),
    securityRepo.countRejections(),
  ]);
  await reply.send({ ok: true, data: rows, counts });
}

/** Aggregated correctness snapshot, also used by the dashboard's integrity panel. */
export async function getIntegrity(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const [dupes, unresolved, mismatch] = await Promise.all([
    query<{ event_id: string; count: number }>(
      'SELECT event_id, COUNT(*)::bigint AS count FROM processed_results GROUP BY event_id HAVING COUNT(*) > 1',
    ),
    query<{ count: number }>(
      `SELECT COUNT(*)::bigint AS count FROM webhook_events
        WHERE status NOT IN ('PROCESSED', 'DEAD_LETTERED')`,
    ),
    query<{ count: number }>(
      `SELECT COUNT(*)::bigint AS count FROM webhook_events e
        WHERE e.status = 'PROCESSED'
          AND NOT EXISTS (SELECT 1 FROM processed_results r WHERE r.event_id = e.event_id)`,
    ),
  ]);
  await reply.send({
    ok: true,
    data: {
      duplicateBusinessEffects: dupes.rows.length,
      duplicateBusinessEffectRows: dupes.rows,
      nonTerminalEvents: Number(unresolved.rows[0]?.count ?? 0),
      processedWithoutResult: Number(mismatch.rows[0]?.count ?? 0),
    },
  });
}
