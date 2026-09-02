import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config/env.js';
import { registerRoutes } from './routes/index.js';
import * as security from './repositories/securityRepository.js';
import { errorMessage, log } from './utils/logger.js';

const here = dirname(fileURLToPath(import.meta.url));
/**
 * Dashboard assets live at <repo>/public. This file runs either from source
 * (server/src/app.ts) or from the build output (dist/server/src/app.js), so the
 * candidates below cover both layouts.
 */
const PUBLIC_DIR =
  [process.env.PUBLIC_DIR, join(here, '..', '..', 'public'), join(here, '..', '..', '..', 'public')].find(
    (dir): dir is string => Boolean(dir) && existsSync(join(dir as string, 'index.html')),
  ) ?? join(here, '..', '..', 'public');

export async function buildApp(): Promise<FastifyInstance> {
  const cfg = config();

  const app = Fastify({
    logger: false, // structured logging is handled by utils/logger
    bodyLimit: 1_048_576, // 1 MiB
    trustProxy: true,
  });

  /**
   * RAW BODY CAPTURE.
   *
   * HMAC is computed over the exact bytes the sender signed. Fastify's default
   * JSON parser would hand us an object, and re-stringifying it can produce
   * different bytes -- so we keep the Buffer and parse it ourselves only after
   * the signature checks out.
   */
  const rawParser = (_req: unknown, body: Buffer, done: (err: Error | null, body: Buffer) => void): void => {
    done(null, body);
  };
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, rawParser as never);
  app.addContentTypeParser('*', { parseAs: 'buffer' }, rawParser as never);

  // Centralised error handling: one shape for every failure, no stack traces on the wire.
  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    const code = (error as { code?: string }).code;
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      await security
        .recordRejection({
          reason: 'BODY_TOO_LARGE',
          signaturePresent: Boolean(request.headers[cfg.SIGNATURE_HEADER.toLowerCase()]),
          remoteIp: request.ip,
          detail: 'request body exceeded 1 MiB',
        })
        .catch(() => undefined);
      await reply.code(413).send({ error: 'Payload too large' });
      return;
    }
    log.error('REQUEST_FAILED', {
      method: request.method,
      url: request.url,
      statusCode: error.statusCode ?? 500,
      message: errorMessage(error),
    });
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    await reply.code(status).send({ error: status >= 500 ? 'Internal server error' : errorMessage(error) });
  });

  app.setNotFoundHandler(async (request, reply) => {
    await reply.code(404).send({ error: `Route ${request.method} ${request.url} not found` });
  });

  await registerRoutes(app);

  // Dashboard (static). Registered last so API routes always win.
  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/', index: ['index.html'] });

  return app;
}
