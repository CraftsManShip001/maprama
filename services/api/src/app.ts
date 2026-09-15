import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ServiceDeps } from './deps.js';
import { ApiError, errorBody } from './errors.js';
import { registerDropRoutes } from './routes/drops.js';
import { registerMapRoutes } from './routes/maps.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerTransitRoutes } from './routes/transit.js';
import { registerUsageRoutes } from './routes/usage.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import type { AppEnv } from './util/http.js';

export type { AppEnv } from './util/http.js';

/**
 * Creates the Diorama API. Every storage/runtime dependency is injected, so
 * the same app runs on Cloudflare Workers (D1/R2), in Node (`dev:local`) and in
 * tests (in-memory adapters).
 */
export function createApp(deps: ServiceDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type', 'If-None-Match'],
      exposeHeaders: ['ETag', 'X-Diorama-Usage', 'X-RateLimit-Limit', 'X-RateLimit-Remaining'],
      maxAge: 86400,
    }),
  );

  app.get('/v1/health', (c) => c.json({ ok: true, service: 'diorama-api' }));

  registerMapRoutes(app, deps);
  registerSearchRoutes(app, deps);
  registerTransitRoutes(app, deps);
  registerDropRoutes(app, deps);
  registerWebhookRoutes(app, deps);
  registerUsageRoutes(app, deps);

  app.notFound((c) => c.json(errorBody('NOT_FOUND', 'Route not found'), 404));
  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(errorBody(err.code, err.message), err.status);
    // Never log request URLs or headers: they may carry API keys.
    console.error('[diorama-api] unhandled error:', err instanceof Error ? err.message : 'unknown');
    return c.json(errorBody('INTERNAL_ERROR', 'Internal server error'), 500);
  });

  return app;
}
