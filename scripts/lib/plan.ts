import { mulberry32, shuffle } from './sender.js';

export interface LogicalEvent {
  eventId: string;
  eventType: string;
  sequence: number;
  timestamp: string;
  data: Record<string, unknown>;
  /** How many times this event is deliberately delivered. */
  deliveries: number;
  expectedTerminalStatus: 'PROCESSED' | 'DEAD_LETTERED';
  /** Minimum processing attempts we expect to see in the database. */
  minAttempts: number;
  category: 'normal' | 'duplicate' | 'storm' | 'transient-failure' | 'permanent-failure';
}

export interface HostileDelivery {
  kind:
    | 'valid'
    | 'wrong-signature'
    | 'missing-signature'
    | 'tampered-body'
    | 'invalid-schema'
    | 'invalid-json';
  eventId: string;
  body: string;
  /** null = send no signature header at all. 'valid' = sign this exact body. */
  signature: 'valid' | 'wrong' | 'stale' | null;
  /** For tampered deliveries: the body that was actually signed. */
  signedBody?: string;
  expectedStatus: number[];
}

export interface HostilePlan {
  logicalEvents: LogicalEvent[];
  deliveries: HostileDelivery[];
  storm: { eventId: string; deliveries: number };
  invalid: {
    wrongSignature: number;
    missingSignature: number;
    tamperedBody: number;
    invalidSchema: number;
    invalidJson: number;
    eventIdsThatMustNeverExist: string[];
  };
  counts: {
    logicalEvents: number;
    totalValidDeliveries: number;
    totalInvalidDeliveries: number;
    duplicateDeliveries: number;
  };
}

const EVENT_TYPES = ['order.created', 'order.updated', 'payment.captured', 'user.registered'];

export interface PlanOptions {
  /** Total number of UNIQUE logical valid events. */
  totalLogicalEvents?: number;
  stormDeliveries?: number;
  transientFailureEvents?: number;
  permanentFailureEvents?: number;
  seed?: number;
}

/**
 * Builds the hostile delivery plan.
 *
 * Composition for the default 1,000 logical events:
 *   990 normal events            (evt_0001 .. evt_0990)
 *     of which evt_0100 x3, evt_0200 x5, evt_0300 x10  -> deliberate duplicates
 *     1 retry-storm event        (evt_storm_001, delivered 50x inside 2s)
 *     8 transient-failure events (evt_retry_001..008, fail twice then succeed)
 *     1 permanent-failure event  (evt_dead_001, fails forever -> dead letter)
 * plus invalid deliveries that must be rejected and must never touch the inbox.
 */
export function buildPlan(options: PlanOptions = {}): HostilePlan {
  const total = options.totalLogicalEvents ?? 1000;
  const stormDeliveries = options.stormDeliveries ?? 50;
  const transientCount = options.transientFailureEvents ?? 8;
  const permanentCount = options.permanentFailureEvents ?? 1;
  const seed = options.seed ?? 20260902;
  const random = mulberry32(seed);
  const baseTime = Date.UTC(2026, 8, 2, 10, 0, 0);

  const normalCount = total - 1 /* storm */ - transientCount - permanentCount;
  if (normalCount < 1) throw new Error('totalLogicalEvents too small for the configured scenarios');

  const duplicatePlan = new Map<string, number>([
    ['evt_0100', 3],
    ['evt_0200', 5],
    ['evt_0300', 10],
  ]);

  const logicalEvents: LogicalEvent[] = [];

  for (let i = 1; i <= normalCount; i++) {
    const eventId = `evt_${String(i).padStart(4, '0')}`;
    const deliveries = duplicatePlan.get(eventId) ?? 1;
    logicalEvents.push({
      eventId,
      eventType: EVENT_TYPES[i % EVENT_TYPES.length] as string,
      sequence: i,
      timestamp: new Date(baseTime + i * 1000).toISOString(),
      data: {
        orderId: `order_${String(i).padStart(6, '0')}`,
        customerId: `customer_${(i % 50) + 1}`,
        amount: Number(((i % 400) + 10.5).toFixed(2)),
      },
      deliveries,
      expectedTerminalStatus: 'PROCESSED',
      minAttempts: 1,
      category: deliveries > 1 ? 'duplicate' : 'normal',
    });
  }

  // Retry storm: one logical event, many simultaneous deliveries.
  logicalEvents.push({
    eventId: 'evt_storm_001',
    eventType: 'order.created',
    sequence: normalCount + 1,
    timestamp: new Date(baseTime + (normalCount + 1) * 1000).toISOString(),
    data: { orderId: 'order_storm_001', customerId: 'customer_storm', amount: 999.99 },
    deliveries: stormDeliveries,
    expectedTerminalStatus: 'PROCESSED',
    minAttempts: 1,
    category: 'storm',
  });

  // Transient failures: fail attempts 1 and 2, succeed on attempt 3.
  for (let i = 1; i <= transientCount; i++) {
    logicalEvents.push({
      eventId: `evt_retry_${String(i).padStart(3, '0')}`,
      eventType: 'payment.captured',
      sequence: normalCount + 1 + i,
      timestamp: new Date(baseTime + (normalCount + 1 + i) * 1000).toISOString(),
      data: {
        orderId: `order_retry_${i}`,
        customerId: 'customer_flaky',
        amount: 42,
        failUntilAttempt: 3,
      },
      deliveries: 1,
      expectedTerminalStatus: 'PROCESSED',
      minAttempts: 3,
      category: 'transient-failure',
    });
  }

  // Permanent failure: fails every attempt until the dead-letter store catches it.
  for (let i = 1; i <= permanentCount; i++) {
    logicalEvents.push({
      eventId: `evt_dead_${String(i).padStart(3, '0')}`,
      eventType: 'order.updated',
      sequence: normalCount + 1 + transientCount + i,
      timestamp: new Date(baseTime + (normalCount + 1 + transientCount + i) * 1000).toISOString(),
      data: { orderId: `order_dead_${i}`, customerId: 'customer_doomed', amount: 1, alwaysFail: true },
      deliveries: 1,
      expectedTerminalStatus: 'DEAD_LETTERED',
      minAttempts: 5,
      category: 'permanent-failure',
    });
  }

  // ---- valid deliveries (one entry per HTTP request) ------------------------
  const valid: HostileDelivery[] = [];
  for (const ev of logicalEvents) {
    const body = JSON.stringify({
      eventId: ev.eventId,
      eventType: ev.eventType,
      sequence: ev.sequence,
      timestamp: ev.timestamp,
      data: ev.data,
    });
    // Storm deliveries are dispatched separately (all at once); everything else
    // goes into the shuffled stream.
    const copies = ev.category === 'storm' ? 0 : ev.deliveries;
    for (let d = 0; d < copies; d++) {
      valid.push({ kind: 'valid', eventId: ev.eventId, body, signature: 'valid', expectedStatus: [202, 200] });
    }
  }

  // ---- invalid deliveries ---------------------------------------------------
  const invalidIds: string[] = [];
  const invalid: HostileDelivery[] = [];
  const mkBody = (id: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      eventId: id,
      eventType: 'order.created',
      sequence: 90_000 + invalid.length,
      timestamp: new Date(baseTime).toISOString(),
      data: { orderId: id, customerId: 'customer_attacker', amount: 1_000_000 },
      ...extra,
    });

  for (let i = 1; i <= 10; i++) {
    const id = `evt_invalid_sig_${String(i).padStart(3, '0')}`;
    invalidIds.push(id);
    invalid.push({
      kind: 'wrong-signature',
      eventId: id,
      body: mkBody(id),
      signature: 'wrong',
      expectedStatus: [401],
    });
  }
  for (let i = 1; i <= 10; i++) {
    const id = `evt_missing_sig_${String(i).padStart(3, '0')}`;
    invalidIds.push(id);
    invalid.push({
      kind: 'missing-signature',
      eventId: id,
      body: mkBody(id),
      signature: null,
      expectedStatus: [401],
    });
  }
  for (let i = 1; i <= 10; i++) {
    const id = `evt_tampered_${String(i).padStart(3, '0')}`;
    const original = mkBody(id);
    invalidIds.push(id);
    // Body is modified AFTER signing: signature is valid for `signedBody`, not `body`.
    const tampered = original.replace('"amount":1000000', '"amount":999999999');
    invalid.push({
      kind: 'tampered-body',
      eventId: id,
      body: tampered,
      signature: 'stale',
      signedBody: original,
      expectedStatus: [401],
    });
  }
  for (let i = 1; i <= 5; i++) {
    const id = `evt_badschema_${String(i).padStart(3, '0')}`;
    invalidIds.push(id);
    // Correctly signed, but eventId is missing -> schema rejection.
    invalid.push({
      kind: 'invalid-schema',
      eventId: id,
      body: JSON.stringify({
        eventType: 'order.created',
        sequence: 1,
        timestamp: new Date(baseTime).toISOString(),
        data: { orderId: id },
      }),
      signature: 'valid',
      expectedStatus: [400],
    });
  }
  for (let i = 1; i <= 5; i++) {
    const id = `evt_badjson_${String(i).padStart(3, '0')}`;
    invalidIds.push(id);
    invalid.push({
      kind: 'invalid-json',
      eventId: id,
      body: `{"eventId":"${id}", this is not json`,
      signature: 'valid',
      expectedStatus: [400],
    });
  }

  // Out-of-order arrival: the delivery stream is shuffled, so sequence numbers
  // arrive scrambled and duplicates are separated from their originals.
  const deliveries = shuffle([...valid, ...invalid], random);

  const totalValidDeliveries = valid.length + stormDeliveries;
  return {
    logicalEvents,
    deliveries,
    storm: { eventId: 'evt_storm_001', deliveries: stormDeliveries },
    invalid: {
      wrongSignature: 10,
      missingSignature: 10,
      tamperedBody: 10,
      invalidSchema: 5,
      invalidJson: 5,
      eventIdsThatMustNeverExist: invalidIds,
    },
    counts: {
      logicalEvents: logicalEvents.length,
      totalValidDeliveries,
      totalInvalidDeliveries: invalid.length,
      duplicateDeliveries: totalValidDeliveries - logicalEvents.length,
    },
  };
}
