import { createHmac, timingSafeEqual } from 'node:crypto';

export type SignatureCheck =
  | { ok: true }
  | { ok: false; reason: 'MISSING_SIGNATURE' | 'MALFORMED_SIGNATURE' | 'INVALID_SIGNATURE' };

/** HMAC-SHA256 of the RAW request body, hex encoded. */
export function computeSignature(rawBody: Buffer | string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** Senders may prefix the digest, e.g. `sha256=abc...`. Both forms are accepted. */
function normalise(header: string): string {
  const trimmed = header.trim();
  const eq = trimmed.indexOf('=');
  if (eq !== -1) {
    const scheme = trimmed.slice(0, eq).trim().toLowerCase();
    if (scheme === 'sha256') return trimmed.slice(eq + 1).trim().toLowerCase();
  }
  return trimmed.toLowerCase();
}

/**
 * Verifies a delivery signature.
 *
 * The comparison is timing-safe: comparing with `===` would leak, byte by byte,
 * how much of a guessed signature was correct, which is enough to forge one.
 * Length is checked first because timingSafeEqual throws on length mismatch --
 * length is not a secret, the digest length is fixed and public.
 */
export function verifySignature(
  rawBody: Buffer | string,
  headerValue: string | undefined | null,
  secret: string,
): SignatureCheck {
  if (headerValue === undefined || headerValue === null || headerValue.trim() === '') {
    return { ok: false, reason: 'MISSING_SIGNATURE' };
  }
  const provided = normalise(headerValue);
  if (!/^[0-9a-f]{64}$/.test(provided)) {
    return { ok: false, reason: 'MALFORMED_SIGNATURE' };
  }
  const expected = computeSignature(rawBody, secret);
  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return { ok: false, reason: 'INVALID_SIGNATURE' };
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'INVALID_SIGNATURE' };
}
