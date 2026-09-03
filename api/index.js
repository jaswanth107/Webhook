/**
 * Vercel serverless entry point.
 *
 * Deliberately calls buildApp() and NOT the index.ts bootstrap. That bootstrap
 * starts the worker loop, runs migrations and runs startup recovery -- all
 * three are wrong in a function that may run many times concurrently:
 *
 *   - the worker loop would be killed the moment the response is sent
 *   - migrations take a session advisory lock, unsafe over a pooled connection
 *   - recovery's reclaimAllProcessing has no lease check, so one cold start
 *     would yank events another concurrent invocation is mid-processing
 *
 * Processing is driven by POST /admin/tick from an external scheduler instead.
 * Migrations are run out-of-band with `npm run db:migrate`.
 */
import { buildApp } from '../dist/server/src/app.js';

// One Fastify instance per warm container, shared across invocations.
let appPromise = null;

export default async function handler(req, res) {
  if (!appPromise) {
    appPromise = (async () => {
      const app = await buildApp();
      await app.ready();
      return app;
    })();
  }
  const app = await appPromise;
  app.server.emit('request', req, res);
}
