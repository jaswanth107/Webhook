import { z } from 'zod';

export const EVENT_STATUSES = [
  'RECEIVED',
  'PROCESSING',
  'PROCESSED',
  'RETRY_PENDING',
  'FAILED',
  'DEAD_LETTERED',
] as const;

export type EventStatus = (typeof EVENT_STATUSES)[number];

/** Terminal states -- an event in one of these needs no further work. */
export const TERMINAL_STATUSES: EventStatus[] = ['PROCESSED', 'DEAD_LETTERED'];

/**
 * The wire contract. Anything that does not match this is rejected with 400
 * AFTER signature verification has already passed.
 */
export const WebhookEventSchema = z.object({
  eventId: z.string().min(1).max(255),
  eventType: z.string().min(1).max(255),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string().datetime({ offset: true }),
  data: z.record(z.unknown()),
});

export type WebhookEventPayload = z.infer<typeof WebhookEventSchema>;

export interface WebhookEventRow {
  id: number;
  event_id: string;
  event_type: string;
  sequence: number;
  event_timestamp: Date;
  payload: WebhookEventPayload;
  status: EventStatus;
  received_at: Date;
  processed_at: Date | null;
  processing_attempts: number;
  processing_started_at: Date | null;
  last_error: string | null;
  next_retry_at: Date | null;
  delivery_count: number;
  first_delivery_at: Date;
  last_delivery_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface ProcessedResultRow {
  id: number;
  event_id: string;
  result_type: string;
  processed_data: Record<string, unknown>;
  attempt_number: number;
  created_at: Date;
}

export interface DeadLetterRow {
  id: number;
  original_event_id: string;
  event_type: string;
  payload: WebhookEventPayload;
  failure_reason: string;
  total_attempts: number;
  dead_lettered_at: Date;
  replayed_at: Date | null;
}

export interface WebhookAttemptRow {
  id: number;
  event_id: string;
  attempt_number: number;
  source: 'DELIVERY' | 'PROCESSING' | 'RECOVERY' | 'ADMIN_REPLAY';
  status: string;
  error_message: string | null;
  attempted_at: Date;
}

export type SecurityRejectionReason =
  | 'MISSING_SIGNATURE'
  | 'INVALID_SIGNATURE'
  | 'MALFORMED_SIGNATURE'
  | 'INVALID_JSON'
  | 'SCHEMA_INVALID'
  | 'BODY_TOO_LARGE'
  | 'ADMIN_TOKEN_MISSING'
  | 'ADMIN_TOKEN_INVALID';
