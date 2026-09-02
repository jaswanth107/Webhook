import { createHmac } from 'node:crypto';

export interface SendOptions {
  url: string;
  secret: string;
  /** Signature header name. */
  headerName?: string;
  /** Total attempts a well-behaved sender makes before giving up (at-least-once delivery). */
  maxAttempts?: number;
  baseRetryMs?: number;
}

export interface SendResult {
  status: number;
  body: unknown;
  attempts: number;
  networkErrors: number;
}

export function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Delivers one HTTP request. Mimics a real webhook sender: on a connection
 * failure or 5xx it retries with backoff, which is exactly what produces
 * duplicate deliveries when the receiver dies after committing.
 */
export async function deliver(
  opts: SendOptions,
  body: string,
  signature: string | null,
): Promise<SendResult> {
  const maxAttempts = opts.maxAttempts ?? 40;
  const baseRetryMs = opts.baseRetryMs ?? 250;
  const headerName = opts.headerName ?? 'x-webhook-signature';
  let networkErrors = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (signature !== null) headers[headerName] = signature;
      const res = await fetch(opts.url, { method: 'POST', headers, body });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep raw text */
      }
      if (res.status >= 500 && attempt < maxAttempts) {
        await sleep(Math.min(baseRetryMs * attempt, 2000));
        continue;
      }
      return { status: res.status, body: parsed, attempts: attempt, networkErrors };
    } catch {
      // Receiver is down (this is what the mid-flight crash looks like from
      // outside). Keep retrying -- a webhook sender does not give up quickly.
      networkErrors += 1;
      if (attempt >= maxAttempts) {
        return { status: 0, body: { error: 'unreachable' }, attempts: attempt, networkErrors };
      }
      await sleep(Math.min(baseRetryMs * attempt, 2000));
    }
  }
  return { status: 0, body: { error: 'unreachable' }, attempts: maxAttempts, networkErrors };
}

/** Deterministic PRNG so a hostile run can be reproduced exactly. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

/** Runs tasks with a bounded number in flight (never Promise.all over 1000 requests). */
export async function runPool<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length || 1)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= tasks.length) return;
      results[i] = await (tasks[i] as () => Promise<T>)();
    }
  });
  await Promise.all(workers);
  return results;
}

export async function waitForHealth(baseUrl: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return true;
    } catch {
      /* still down */
    }
    await sleep(250);
  }
  return false;
}
