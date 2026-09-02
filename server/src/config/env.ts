import { z } from 'zod';

/**
 * Environment validation. The process refuses to boot with an invalid or
 * missing configuration -- a receiver with no WEBHOOK_SECRET is worse than
 * a receiver that is down, because it would silently accept forged traffic.
 */
const boolish = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no']))
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),

  WEBHOOK_SECRET: z.string().min(8, 'WEBHOOK_SECRET must be at least 8 characters'),
  SIGNATURE_HEADER: z.string().default('x-webhook-signature'),

  MAX_PROCESSING_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  RETRY_BASE_DELAY_MS: z.coerce.number().int().min(1).default(1000),
  RETRY_MAX_DELAY_MS: z.coerce.number().int().min(1).default(60_000),
  RETRY_JITTER_RATIO: z.coerce.number().min(0).max(1).default(0.2),

  PROCESSING_TIMEOUT_SECONDS: z.coerce.number().int().min(1).default(30),

  WORKER_ENABLED: boolish.default('true'),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(500),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).default(50),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(10),
  RECOVER_ALL_PROCESSING_ON_START: boolish.default('true'),

  PG_POOL_MAX: z.coerce.number().int().min(1).default(20),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),

  /** Enables the deterministic failure handlers used by the hostility test. */
  SIMULATE_FAILURES: boolish.default('false'),
  /** Enables /admin/chaos/* endpoints (controlled crash + reset). Never enable in production. */
  CHAOS_ENABLED: boolish.default('false'),
  /**
   * Hard-kills the process the moment this eventId is picked up for processing
   * (see SIMULATE_CRASH_POINT). Used to prove crash-mid-write safety.
   */
  SIMULATE_CRASH_EVENT: z.string().optional(),
  SIMULATE_CRASH_POINT: z
    .enum(['before_business_effect', 'after_business_effect_before_commit', 'after_commit'])
    .default('after_business_effect_before_commit'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim() !== '') cleaned[key] = value;
  }
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }
  return parsed.data;
}

export function config(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}

export function resetConfigCache(): void {
  cached = null;
}
