import { config } from '../config/env.js';
import * as eventsRepo from '../repositories/eventRepository.js';
import * as attempts from '../repositories/attemptRepository.js';
import * as security from '../repositories/securityRepository.js';
import { verifySignature } from './signature.js';
import { WebhookEventSchema } from '../types/events.js';
import type { EventStatus } from '../types/events.js';
import { eventWorker } from '../workers/eventWorker.js';
import { fingerprint, log } from '../utils/logger.js';

export type IngestResult =
  | { kind: 'ACCEPTED'; eventId: string; deliveryCount: number }
  | { kind: 'DUPLICATE'; eventId: string; status: EventStatus; deliveryCount: number }
  | { kind: 'UNAUTHORIZED'; reason: 'MISSING_SIGNATURE' | 'INVALID_SIGNATURE' | 'MALFORMED_SIGNATURE' }
  | { kind: 'BAD_REQUEST'; reason: 'INVALID_JSON' | 'SCHEMA_INVALID'; detail: string };

export interface IngestInput {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  remoteIp?: string | undefined;
}

/**
 * The full receive path.
 *
 * Order is not negotiable:
 *   1. verify HMAC over the RAW bytes   -- unverified input is never parsed
 *   2. parse + validate
 *   3. durable, idempotent insert       -- commits before we answer
 *   4. acknowledge
 *
 * Step 3 finishing before step 4 is the durability rule: the sender is only
 * ever told "accepted" about an event that is already on disk. Business
 * processing happens afterwards, asynchronously, so the ack stays fast.
 */
export async function ingestDelivery(input: IngestInput): Promise<IngestResult> {
  const cfg = config();
  const { rawBody, signatureHeader, remoteIp } = input;

  log.debug('WEBHOOK_RECEIVED', { bytes: rawBody.length, remoteIp, signaturePresent: Boolean(signatureHeader) });

  // ---- 1. Signature -------------------------------------------------------
  const check = verifySignature(rawBody, signatureHeader, cfg.WEBHOOK_SECRET);
  if (!check.ok) {
    // Deliberately does NOT parse the body: an unverified payload is hostile
    // input, so we log only its shape, never its contents, and never the secret.
    log.warn(check.reason === 'MISSING_SIGNATURE' ? 'SIGNATURE_MISSING' : 'SIGNATURE_INVALID', {
      reason: check.reason,
      remoteIp,
      bytes: rawBody.length,
      signatureFp: fingerprint(signatureHeader),
    });
    await security.recordRejection({
      reason: check.reason,
      signaturePresent: Boolean(signatureHeader && signatureHeader.trim() !== ''),
      signatureFingerprint: fingerprint(signatureHeader),
      remoteIp: remoteIp ?? null,
      detail: `body_bytes=${rawBody.length}`,
    });
    return { kind: 'UNAUTHORIZED', reason: check.reason };
  }
  log.debug('SIGNATURE_VALID', { bytes: rawBody.length });

  // ---- 2. Parse + validate (body is now trusted to come from the sender) ---
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    log.warn('PAYLOAD_INVALID', { reason: 'INVALID_JSON', remoteIp });
    await security.recordRejection({
      reason: 'INVALID_JSON',
      signaturePresent: true,
      signatureFingerprint: fingerprint(signatureHeader),
      remoteIp: remoteIp ?? null,
      detail: 'body is not valid JSON',
    });
    return { kind: 'BAD_REQUEST', reason: 'INVALID_JSON', detail: 'Request body is not valid JSON' };
  }

  const validated = WebhookEventSchema.safeParse(parsed);
  if (!validated.success) {
    const detail = validated.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
      .slice(0, 500);
    const claimedEventId =
      typeof (parsed as { eventId?: unknown })?.eventId === 'string'
        ? ((parsed as { eventId: string }).eventId as string).slice(0, 255)
        : null;
    log.warn('PAYLOAD_INVALID', { reason: 'SCHEMA_INVALID', detail, remoteIp });
    await security.recordRejection({
      reason: 'SCHEMA_INVALID',
      claimedEventId,
      signaturePresent: true,
      signatureFingerprint: fingerprint(signatureHeader),
      remoteIp: remoteIp ?? null,
      detail,
    });
    return { kind: 'BAD_REQUEST', reason: 'SCHEMA_INVALID', detail };
  }

  const payload = validated.data;

  // ---- 3. Durable, idempotent persistence ---------------------------------
  const { row, inserted } = await eventsRepo.upsertEvent(payload);

  await attempts.recordAttempt({
    eventId: row.event_id,
    attemptNumber: row.delivery_count,
    source: 'DELIVERY',
    status: inserted ? 'ACCEPTED' : 'DUPLICATE',
  });

  if (!inserted) {
    log.info('DUPLICATE_EVENT', {
      eventId: row.event_id,
      deliveryCount: row.delivery_count,
      currentStatus: row.status,
    });
    return {
      kind: 'DUPLICATE',
      eventId: row.event_id,
      status: row.status,
      deliveryCount: row.delivery_count,
    };
  }

  log.info('EVENT_ACCEPTED', {
    eventId: row.event_id,
    eventType: row.event_type,
    sequence: row.sequence,
  });

  // ---- 4. Hand off to the async processor (never blocks the ack) ----------
  eventWorker.notify();

  return { kind: 'ACCEPTED', eventId: row.event_id, deliveryCount: row.delivery_count };
}
