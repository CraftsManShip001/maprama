import type { Context } from 'hono';
import type { ApiKeyRecord, ServiceDeps } from '../deps.js';
import { ApiError, badRequest } from '../errors.js';

/** Hono environment used by the app. */
export type AppEnv = { Variables: { apiKey: ApiKeyRecord } };

/** Parses the JSON request body or throws `400 INVALID_JSON`. */
export async function readJson(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'Request body must be valid JSON');
  }
}

/** Runs a task after the response (Workers `waitUntil`), never throwing into the request. */
export function defer(deps: ServiceDeps, c: Context<AppEnv>, task: Promise<unknown>): void {
  const safe = task.catch((err: unknown) => {
    console.error('[diorama-api] background task failed:', err instanceof Error ? err.message : 'unknown error');
  });
  if (deps.waitUntil) {
    deps.waitUntil(safe);
    return;
  }
  try {
    c.executionCtx.waitUntil(safe);
  } catch {
    // No execution context (Node): the promise simply runs detached.
  }
}

/** Parses an optional numeric query parameter within bounds. */
export function numberParam(
  raw: string | undefined,
  name: string,
  opts: { min: number; max: number; fallback?: number; integer?: boolean },
): number {
  if (raw === undefined || raw === '') {
    if (opts.fallback === undefined) throw badRequest(`Missing query parameter "${name}"`);
    return opts.fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || (opts.integer && !Number.isInteger(n)) || n < opts.min || n > opts.max) {
    throw badRequest(`Query parameter "${name}" must be ${opts.integer ? 'an integer' : 'a number'} in [${opts.min}, ${opts.max}]`);
  }
  return n;
}

/** UTC month key `YYYY-MM`. */
export function monthKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

/** Whether an `Accept-Encoding` header accepts `coding` (honours `q=0`). */
export function acceptsEncoding(header: string | undefined, coding: string): boolean {
  if (!header) return false;
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().split(';');
    if (!name) continue;
    const n = name.trim().toLowerCase();
    if (n !== coding && n !== '*') continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    if (q && Number(q.slice(2)) === 0) return false;
    return true;
  }
  return false;
}
