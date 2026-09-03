/**
 * Hostile sender.
 *
 * Fires 1,000 logical events at the receiver under deliberately adversarial
 * conditions: duplicates, a 50-delivery retry storm inside 2 seconds, shuffled
 * (out-of-order) arrival, forged/missing/tampered signatures, malformed bodies,
 * and one mid-flight kill of the receiver process.
 *
 * Writes tmp/hostile-manifest.json describing exactly what was sent, which is
 * what scripts/verify-results.ts checks the database against.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadDotEnv } from '../server/src/config/dotenv.js';
loadDotEnv();

import { buildPlan, type HostileDelivery } from './lib/plan.js';
import { deliver, runPool, sign, sleep, waitForHealth } from './lib/sender.js';
import { adminFetch } from './lib/adminFetch.js';

interface Args {
  url: string;
  secret: string;
  events: number;
  concurrency: number;
  crash: boolean;
  crashAt: number;
  stormAt: number;
  seed: number;
  out: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const withEq = argv.find((a) => a.startsWith(`--${name}=`));
    if (withEq) return withEq.split('=').slice(1).join('=');
    const idx = argv.indexOf(`--${name}`);
    if (idx !== -1 && argv[idx + 1] && !argv[idx + 1]!.startsWith('--')) return argv[idx + 1];
    return undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);

  return {
    url: get('url') ?? process.env.RECEIVER_URL ?? 'http://localhost:3000',
    secret: get('secret') ?? process.env.WEBHOOK_SECRET ?? '',
    events: Number(get('events') ?? 1000),
    concurrency: Number(get('concurrency') ?? 25),
    crash: !has('no-crash'),
    crashAt: Number(get('crash-at') ?? 500),
    stormAt: Number(get('storm-at') ?? 300),
    seed: Number(get('seed') ?? 20260902),
    out: resolve(get('out') ?? 'tmp/hostile-manifest.json'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.secret) throw new Error('WEBHOOK_SECRET is required (env or --secret)');

  const endpoint = `${args.url}/webhooks/events`;
  const plan = buildPlan({ totalLogicalEvents: args.events, seed: args.seed });

  console.log('┌────────────────────────────────────────────────────────────┐');
  console.log('│  HOSTILE SENDER                                            │');
  console.log('└────────────────────────────────────────────────────────────┘');
  console.log(`  receiver              : ${endpoint}`);
  console.log(`  logical events        : ${plan.counts.logicalEvents}`);
  console.log(`  valid deliveries      : ${plan.counts.totalValidDeliveries} (${plan.counts.duplicateDeliveries} duplicates)`);
  console.log(`  invalid deliveries    : ${plan.counts.totalInvalidDeliveries}`);
  console.log(`  retry storm           : ${plan.storm.deliveries}x ${plan.storm.eventId} in <2s`);
  console.log(`  mid-flight crash      : ${args.crash ? `after ${args.crashAt} deliveries` : 'disabled'}`);
  console.log(`  seed                  : ${args.seed}\n`);

  if (!(await waitForHealth(args.url, 30_000))) {
    throw new Error(`Receiver at ${args.url} is not healthy`);
  }

  const sendOpts = { url: endpoint, secret: args.secret };
  const statusCounts: Record<string, number> = {};
  const perKindStatus: Record<string, Record<string, number>> = {};
  let networkErrors = 0;
  let completed = 0;
  let dispatched = 0;

  const crashInfo = {
    triggered: false,
    triggeredAtDelivery: 0,
    triggeredAt: '' as string,
    downtimeMs: 0,
    firstSuccessAfterCrashMs: 0,
  };
  let crashTriggeredMs = 0;
  let recoveredLogged = false;

  const stormInfo = {
    started: '' as string,
    durationMs: 0,
    statusCounts: {} as Record<string, number>,
    /** HTTP requests actually issued, including sender-side retries after network errors. */
    requestsIssued: 0,
  };
  let stormPromise: Promise<void> | null = null;

  const signatureFor = (d: HostileDelivery): string | null => {
    switch (d.signature) {
      case 'valid':
        return sign(d.body, args.secret);
      case 'wrong':
        // Correct algorithm, wrong secret -- the classic forged webhook.
        return sign(d.body, `${args.secret}-attacker`);
      case 'stale':
        // Signature of the ORIGINAL body; the body was modified after signing.
        return sign(d.signedBody ?? d.body, args.secret);
      case null:
      default:
        return null;
    }
  };

  const record = (kind: string, status: number, errors: number): void => {
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    perKindStatus[kind] ??= {};
    perKindStatus[kind]![status] = (perKindStatus[kind]![status] ?? 0) + 1;
    networkErrors += errors;
  };

  /** 50 identical deliveries dispatched simultaneously -- the retry storm. */
  const fireStorm = async (): Promise<void> => {
    const ev = plan.logicalEvents.find((e) => e.eventId === plan.storm.eventId)!;
    const body = JSON.stringify({
      eventId: ev.eventId,
      eventType: ev.eventType,
      sequence: ev.sequence,
      timestamp: ev.timestamp,
      data: ev.data,
    });
    const signature = sign(body, args.secret);
    const started = Date.now();
    stormInfo.started = new Date(started).toISOString();
    console.log(`  ⚡ retry storm: ${plan.storm.deliveries}x ${ev.eventId} dispatched simultaneously`);
    const results = await Promise.all(
      Array.from({ length: plan.storm.deliveries }, () => deliver(sendOpts, body, signature)),
    );
    stormInfo.durationMs = Date.now() - started;
    for (const r of results) {
      stormInfo.statusCounts[r.status] = (stormInfo.statusCounts[r.status] ?? 0) + 1;
      stormInfo.requestsIssued += r.attempts;
      record('storm', r.status, r.networkErrors);
    }
    console.log(
      `  ⚡ retry storm complete in ${stormInfo.durationMs}ms -> ${JSON.stringify(stormInfo.statusCounts)}`,
    );
  };

  /** Kills the receiver while events are still being processed. */
  const triggerCrash = async (): Promise<void> => {
    crashInfo.triggered = true;
    crashInfo.triggeredAtDelivery = completed;
    crashInfo.triggeredAt = new Date().toISOString();
    crashTriggeredMs = Date.now();
    console.log(`\n  💥 MID-FLIGHT CRASH: killing the receiver after ${completed} deliveries...`);
    try {
      await adminFetch(`${args.url}/admin/chaos/crash?delayMs=0`, { method: 'POST' });
    } catch {
      // The process can die before the response is flushed -- that is a success.
    }
  };

  // Sequence numbers in dispatch order, used to prove arrival was out of order.
  const arrivalSequences: number[] = [];
  const validEventById = new Map(plan.logicalEvents.map((e) => [e.eventId, e]));

  const tasks = plan.deliveries.map((d) => async () => {
    dispatched += 1;
    const ev = validEventById.get(d.eventId);
    if (d.kind === 'valid' && ev) arrivalSequences.push(ev.sequence);

    const res = await deliver(sendOpts, d.body, signatureFor(d));
    record(d.kind, res.status, res.networkErrors);
    if (res.networkErrors > 0 && crashInfo.triggered && !recoveredLogged && res.status !== 0) {
      recoveredLogged = true;
      crashInfo.firstSuccessAfterCrashMs = Date.now() - crashTriggeredMs;
      crashInfo.downtimeMs = crashInfo.firstSuccessAfterCrashMs;
      console.log(`  ♻️  receiver answered again ${crashInfo.downtimeMs}ms after the kill`);
    }
    completed += 1;

    if (completed === args.stormAt && stormPromise === null) {
      stormPromise = fireStorm();
    }
    if (args.crash && !crashInfo.triggered && completed >= args.crashAt) {
      await triggerCrash();
    }
    if (completed % 250 === 0) {
      console.log(`  … ${completed}/${plan.deliveries.length} deliveries sent`);
    }
  });

  const startedAt = Date.now();
  await runPool(tasks, args.concurrency);
  if (stormPromise === null) stormPromise = fireStorm();
  await stormPromise;
  const wallMs = Date.now() - startedAt;

  // If the crash landed near the end, make sure the receiver is back before we
  // hand over to the verifier.
  if (crashInfo.triggered) {
    const back = await waitForHealth(args.url, 90_000);
    if (!back) throw new Error('Receiver did not come back after the mid-flight crash');
    if (crashInfo.downtimeMs === 0) crashInfo.downtimeMs = Date.now() - crashTriggeredMs;
  }

  // How out-of-order was the arrival stream? Count inversions on a sample.
  const sample = arrivalSequences.slice(0, 400);
  let inversions = 0;
  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < sample.length; j++) if ((sample[i] as number) > (sample[j] as number)) inversions++;
  }
  const maxInversions = (sample.length * (sample.length - 1)) / 2;

  const manifest = {
    generatedAt: new Date().toISOString(),
    receiverUrl: args.url,
    seed: args.seed,
    wallMs,
    counts: plan.counts,
    storm: { ...plan.storm, ...stormInfo },
    crash: crashInfo,
    invalid: plan.invalid,
    statusCounts,
    perKindStatus,
    networkErrors,
    outOfOrder: {
      sampledDeliveries: sample.length,
      inversions,
      maxInversions,
      ratio: maxInversions === 0 ? 0 : Number((inversions / maxInversions).toFixed(4)),
    },
    logicalEvents: plan.logicalEvents.map((e) => ({
      eventId: e.eventId,
      eventType: e.eventType,
      sequence: e.sequence,
      deliveries: e.deliveries,
      expectedTerminalStatus: e.expectedTerminalStatus,
      minAttempts: e.minAttempts,
      category: e.category,
    })),
  };

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(manifest, null, 2));

  console.log('\n  ── delivery summary ─────────────────────────────────────');
  console.log(`  wall time             : ${wallMs}ms`);
  console.log(`  HTTP status counts    : ${JSON.stringify(statusCounts)}`);
  console.log(`  sender-side retries   : ${networkErrors} (connection refused during the crash window)`);
  console.log(
    `  out-of-order arrivals : ${inversions}/${maxInversions} inversions (${(manifest.outOfOrder.ratio * 100).toFixed(1)}% of pairs)`,
  );
  if (crashInfo.triggered) {
    console.log(`  crash                 : after ${crashInfo.triggeredAtDelivery} deliveries, back in ${crashInfo.downtimeMs}ms`);
  }
  console.log(`  manifest              : ${args.out}\n`);
  await sleep(50);
}

main().catch((err) => {
  console.error('\nSender failed:', err);
  process.exit(1);
});
