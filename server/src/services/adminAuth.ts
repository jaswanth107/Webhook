import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config/env.js';
import * as security from '../repositories/securityRepository.js';
import { fingerprint, log } from '../utils/logger.js';

/**
 * Constant-time token comparison.
 *
 * Same reasoning as the webhook signature check: `===` would leak how much of a
 * guessed token was correct. Lengths are compared first because timingSafeEqual
 * throws on a length mismatch, and the length of a token is not the secret.
 */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Accepts `Authorization: Bearer <token>` or `X-Admin-Token: <token>`. */
function presentedToken(request: FastifyRequest): string | null {
  const auth = request.headers.authorization;
  if (typeof auth === 'string' && auth.trim() !== '') {
    const [scheme, ...rest] = auth.trim().split(/\s+/);
    if (scheme?.toLowerCase() === 'bearer' && rest.length > 0) return rest.join(' ');
    return auth.trim();
  }
  const header = request.headers['x-admin-token'];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Guards every /admin/* route, including the chaos endpoints.
 *
 * When ADMIN_API_TOKEN is unset the API stays open, so a local `docker compose
 * up` and the hostility test work with no setup. That is only safe because
 * config validation makes the token mandatory whenever NODE_ENV=production.
 */
export async function requireAdminAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const cfg = config();
  if (!cfg.ADMIN_API_TOKEN) return;
  if (!request.url.startsWith('/admin/')) return;

  const provided = presentedToken(request);
  if (provided !== null && tokenMatches(provided, cfg.ADMIN_API_TOKEN)) return;

  const reason = provided === null ? 'ADMIN_TOKEN_MISSING' : 'ADMIN_TOKEN_INVALID';
  log.warn('ADMIN_UNAUTHORIZED', {
    reason,
    method: request.method,
    url: request.url,
    remoteIp: request.ip,
    tokenFp: fingerprint(provided ?? undefined),
  });
  // Rejected admin traffic belongs in the same audit trail as rejected
  // deliveries -- an attacker probing /admin is exactly what it is for.
  await security
    .recordRejection({
      reason,
      signaturePresent: provided !== null,
      signatureFingerprint: fingerprint(provided ?? undefined),
      remoteIp: request.ip ?? null,
      detail: `${request.method} ${request.url}`,
    })
    .catch(() => undefined);

  await reply
    .code(401)
    .header('www-authenticate', 'Bearer realm="webhook-fortress-admin"')
    .send({ ok: false, error: 'Admin authentication required', reason });
}
