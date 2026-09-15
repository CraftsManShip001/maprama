/**
 * `@maprama/api`: the hosted Maprama service as a library.
 *
 * - {@link createApp}: Hono app factory over injected dependencies.
 * - Adapters: in-memory (`createMemoryDeps`), Cloudflare D1 (`createD1Repos`) and R2 (`R2BlobStore`).
 * - Verification helpers for app servers: also available as `@maprama/api/verify`.
 *
 * @packageDocumentation
 */
export { createApp } from './app.js';
export type { AppEnv } from './app.js';
export type * from './deps.js';
export { BLOB_KEYS, COLLECT_RULES, DROP_LIMITS, PLAN_DEFAULT_QUOTA, SEARCH_LIMITS, UNIT_WEIGHTS, USAGE_UNITS } from './config.js';
export { ApiError } from './errors.js';
export type { ErrorCode } from './errors.js';
export { createD1Repos } from './adapters/d1/repos.js';
export { R2BlobStore } from './adapters/r2.js';
export { ManualClock, MemoryBlobStore, createMemoryDeps, systemClock } from './adapters/memory/index.js';
export type { MemoryDepsOptions, MemoryServiceDeps } from './adapters/memory/index.js';
export { createWorkerDeps } from './worker.js';
export type { Env } from './worker.js';
export { deriveReceiptSecret, generateApiKey, sha256Hex } from './util/crypto.js';
export { encodeDropId, generateCellDrops, nearbyDrops, parseDropId } from './drops/generate.js';
export * from './verify.js';
