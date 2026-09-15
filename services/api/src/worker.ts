/**
 * Cloudflare Workers entry: wires D1 (`DB`) and R2 (`TILES`) bindings into the app.
 * Secrets: `wrangler secret put RECEIPT_SECRET`.
 */
import type { D1Database, R2Bucket } from '@cloudflare/workers-types/index';
import type { ExecutionContext } from 'hono';
import { createApp } from './app.js';
import { createD1Repos } from './adapters/d1/repos.js';
import { R2BlobStore } from './adapters/r2.js';
import type { ServiceDeps } from './deps.js';

export interface Env {
  DB: D1Database;
  TILES: R2Bucket;
  RECEIPT_SECRET: string;
}

export function createWorkerDeps(env: Env): ServiceDeps {
  if (!env.RECEIPT_SECRET || env.RECEIPT_SECRET.length < 32) {
    throw new Error('RECEIPT_SECRET must be set (>= 32 characters) via `wrangler secret put RECEIPT_SECRET`');
  }
  return {
    ...createD1Repos(env.DB),
    blobs: new R2BlobStore(env.TILES),
    clock: { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
    crypto: globalThis.crypto,
    fetch: (input, init) => fetch(input, init),
    secrets: { receiptSecret: env.RECEIPT_SECRET },
    // The Workers runtime encodes bodies according to Content-Encoding.
    options: { tileEncoding: 'runtime' },
  };
}

let cached: { env: Env; app: ReturnType<typeof createApp> } | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    if (!cached || cached.env !== env) cached = { env, app: createApp(createWorkerDeps(env)) };
    return cached.app.fetch(request, env, ctx);
  },
};
