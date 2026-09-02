import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config/env.js';
import { ingestDelivery } from '../services/ingestion.js';

/**
 * POST /webhooks/events
 *
 * `request.body` is the RAW Buffer (see the content-type parser in app.ts):
 * re-serialising a parsed object would change bytes (key order, spacing) and
 * break signature verification for a perfectly valid delivery.
 */
export async function receiveWebhook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const cfg = config();
  const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.from('');
  const headerName = cfg.SIGNATURE_HEADER.toLowerCase();
  const headerValue = request.headers[headerName];
  const signatureHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  const result = await ingestDelivery({
    rawBody,
    signatureHeader,
    remoteIp: request.ip,
  });

  switch (result.kind) {
    case 'ACCEPTED':
      await reply.code(202).send({ status: 'accepted', eventId: result.eventId });
      return;
    case 'DUPLICATE':
      await reply.code(200).send({
        status: 'duplicate',
        eventId: result.eventId,
        eventStatus: result.status,
        deliveryCount: result.deliveryCount,
      });
      return;
    case 'UNAUTHORIZED':
      await reply.code(401).send({
        error: result.reason === 'MISSING_SIGNATURE' ? 'Missing webhook signature' : 'Invalid webhook signature',
        reason: result.reason,
      });
      return;
    case 'BAD_REQUEST':
      await reply.code(400).send({
        error: result.reason === 'INVALID_JSON' ? 'Invalid JSON body' : 'Invalid event payload',
        reason: result.reason,
        detail: result.detail,
      });
      return;
  }
}
