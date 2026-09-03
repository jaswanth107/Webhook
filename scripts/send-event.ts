/**
 * Send ONE event of your own to the receiver, correctly signed, and watch what
 * the database does with it.
 *
 *   npm run send:event -- --file my-event.json --watch
 *   npm run send:event -- --id evt_mine_001 --type order.created --data '{"amount":42}' --watch
 *   npm run send:event -- --file my-event.json --times 20        # duplicate storm
 *   npm run send:event -- --file my-event.json --bad-signature   # should be rejected
 *
 * This is the tool for checking the receiver against YOUR values rather than
 * the generated hostility-test traffic.
 */
import { readFileSync } from 'node:fs';
import { loadDotEnv } from '../server/src/config/dotenv.js';
loadDotEnv();

import { deliver, sign, sleep } from './lib/sender.js';
import { adminFetch } from './lib/adminFetch.js';

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const opt = (name: string, fallback?: string): string | undefined => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1]!.startsWith('--')) return argv[i + 1];
  return fallback;
};

const URL_BASE = opt('url', process.env.RECEIVER_URL ?? 'http://localhost:3000')!;
const SECRET = opt('secret', process.env.WEBHOOK_SECRET)!;

function usage(): never {
  console.log(`
Send one (or many) hand-written events to the receiver.

  --file <path>        JSON file holding the event (missing fields are filled in)
  --raw <path>         send the file's bytes VERBATIM (use to test invalid JSON)
  --data '<json>'      the event's "data" object
  --id <eventId>       default: evt_manual_<timestamp>
  --type <eventType>   default: order.created
  --seq <n>            default: 1

  --times <n>          deliver the same body n times (duplicate / storm check)
  --concurrent         send those n deliveries simultaneously

  --no-signature       omit the signature header      (expect 401)
  --bad-signature      sign with the wrong secret     (expect 401)
  --tamper             sign, then modify the body     (expect 401)

  --watch              poll until the event reaches a terminal state and print it
  --url / --secret     override RECEIVER_URL / WEBHOOK_SECRET
`);
  process.exit(0);
}

if (flag('help') || flag('h')) usage();
if (!SECRET) throw new Error('WEBHOOK_SECRET is required (env, .env or --secret)');

// ---- build the body -------------------------------------------------------
const rawPath = opt('raw');
let body: string;
let eventId: string;

if (rawPath) {
  body = readFileSync(rawPath, 'utf8');
  eventId = opt('id', '(raw body)')!;
} else {
  const fromFile = opt('file') ? (JSON.parse(readFileSync(opt('file')!, 'utf8')) as Record<string, unknown>) : {};
  const dataFlag = opt('data');
  const event = {
    eventId: opt('id') ?? (fromFile.eventId as string) ?? `evt_manual_${Date.now().toString(36)}`,
    eventType: opt('type') ?? (fromFile.eventType as string) ?? 'order.created',
    sequence: Number(opt('seq') ?? (fromFile.sequence as number) ?? 1),
    timestamp: (fromFile.timestamp as string) ?? new Date().toISOString(),
    data: dataFlag ? (JSON.parse(dataFlag) as Record<string, unknown>) : ((fromFile.data as object) ?? {}),
  };
  eventId = event.eventId;
  body = JSON.stringify(event);
}

// ---- choose the signature -------------------------------------------------
let sentBody = body;
let signature: string | null;
let mode = 'valid signature';
if (flag('no-signature')) {
  signature = null;
  mode = 'NO signature header';
} else if (flag('bad-signature')) {
  signature = sign(body, `${SECRET}-wrong`);
  mode = 'signature from the WRONG secret';
} else if (flag('tamper')) {
  signature = sign(body, SECRET); // signs the original…
  sentBody = body.replace(/}\s*$/, ',"tampered":true}'); // …then the body changes
  mode = 'body modified AFTER signing';
} else {
  signature = sign(body, SECRET);
}

const times = Number(opt('times') ?? 1);
const concurrent = flag('concurrent');

async function main(): Promise<void> {
  console.log(`\n→ POST ${URL_BASE}/webhooks/events`);
  console.log(`  eventId : ${eventId}`);
  console.log(`  mode    : ${mode}`);
  console.log(`  body    : ${sentBody.length > 300 ? `${sentBody.slice(0, 300)}…` : sentBody}`);
  console.log(`  sending : ${times} ${times === 1 ? 'delivery' : `deliveries${concurrent ? ' (simultaneously)' : ''}`}\n`);

  const send = () => deliver({ url: `${URL_BASE}/webhooks/events`, secret: SECRET, maxAttempts: 3 }, sentBody, signature);
  const results = concurrent
    ? await Promise.all(Array.from({ length: times }, send))
    : await (async () => {
        const out = [];
        for (let i = 0; i < times; i++) out.push(await send());
        return out;
      })();

  const byStatus: Record<string, number> = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  for (const [status, count] of Object.entries(byStatus)) {
    const sample = results.find((r) => String(r.status) === status)!;
    console.log(`  HTTP ${status} ×${count}  ${JSON.stringify(sample.body)}`);
  }

  if (!flag('watch')) {
    console.log(`\n  inspect it: ${URL_BASE}/?view=events&event=${encodeURIComponent(eventId)}\n`);
    return;
  }

  // ---- watch the database decide what happens to it ------------------------
  console.log('\n  watching until the event reaches a terminal state…');
  const deadline = Date.now() + 120_000;
  for (;;) {
    const res = await adminFetch(`${URL_BASE}/admin/events/${encodeURIComponent(eventId)}`);
    if (res.status === 404) {
      console.log('\n  the receiver has NO record of this event — it was rejected before the inbox.');
      const sec = (await (await adminFetch(`${URL_BASE}/admin/security-events?limit=5`)).json()) as {
        data: { reason: string; detail: string | null; created_at: string }[];
      };
      const hit = sec.data[0];
      if (hit) console.log(`  latest rejection: ${hit.reason} (${hit.detail ?? ''})`);
      console.log('');
      return;
    }
    const { data } = (await res.json()) as {
      data: {
        event: { status: string; processing_attempts: number; delivery_count: number; last_error: string | null; next_retry_at: string | null };
        attempts: { source: string; status: string; attempt_number: number; error_message: string | null; attempted_at: string }[];
        processedResult: { result_type: string; processed_data: unknown } | null;
        deadLetter: { failure_reason: string; total_attempts: number } | null;
      };
    };
    const terminal = data.event.status === 'PROCESSED' || data.event.status === 'DEAD_LETTERED';
    if (terminal || Date.now() > deadline) {
      console.log(`\n  status          : ${data.event.status}`);
      console.log(`  attempts        : ${data.event.processing_attempts}`);
      console.log(`  deliveries      : ${data.event.delivery_count}`);
      console.log(`  business effect : ${data.processedResult ? `1 (${data.processedResult.result_type})` : 'none'}`);
      if (data.deadLetter) console.log(`  dead letter     : ${data.deadLetter.failure_reason}`);
      console.log('  timeline        :');
      for (const a of data.attempts) {
        console.log(`     ${a.source.padEnd(10)} ${a.status.padEnd(14)} #${a.attempt_number} ${(a.error_message ?? '').slice(0, 60)}`);
      }
      if (data.processedResult) console.log(`  effect payload  : ${JSON.stringify(data.processedResult.processed_data)}`);
      console.log('');
      return;
    }
    await sleep(400);
  }
}

main().catch((err) => {
  console.error('\nfailed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
