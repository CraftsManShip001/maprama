/**
 * Client for the hosted drops service (`services/api/openapi.yaml`):
 * `GET /v1/drops/nearby` and `POST /v1/drops/collect`.
 *
 * @module
 */

import { validateEngineCommand, type DropSpec } from '@maprama/protocol';

/** Connection settings for the drops service. */
export interface DropsServiceConfig {
  /** Base URL without the `/v1` suffix, e.g. `https://api.example`. */
  baseUrl: string;
  /** API key, sent as `Authorization: Bearer <key>`. */
  apiKey: string;
  /** Custom fetch implementation. Default: global `fetch`. */
  fetch?: FetchLike;
}

/** Minimal `fetch` signature used by the client. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  /** Response headers; read for `Retry-After`. Optional so minimal fetch shims work. */
  headers?: { get(name: string): string | null };
}>;

/** Query of `GET /v1/drops/nearby`. */
export interface NearbyDropsQuery {
  lng: number;
  lat: number;
  /** Radius in meters (1..3000). Service default 500. */
  radiusMeters?: number;
  channel: string;
}

/** Response of `GET /v1/drops/nearby`. */
export interface NearbyDropsResponse {
  /** Drops sorted by distance. */
  drops: DropSpec[];
  /** Server time in ms, `null` when not reported. */
  generatedAt: number | null;
  /** End of the earliest current window in ms (refetch after it); `null` when unknown. */
  expiresAt: number | null;
}

/** Location fix sent with a collect verification. */
export interface CollectFix {
  lng: number;
  lat: number;
  accuracyMeters: number;
  /** Milliseconds since the Unix epoch. */
  timestamp: number;
}

/** Body of `POST /v1/drops/collect`. */
export interface CollectVerifyRequest {
  dropId: string;
  collectId: string;
  userId: string;
  fix: CollectFix;
}

/** `200` response of `POST /v1/drops/collect`. */
export interface CollectVerifyResponse {
  /** `base64url(claims).base64url(HMAC)`; verify on your server. */
  receipt: string;
  replayed: boolean;
  collect: { dropId: string; collectId: string; userId: string; collectedAt: number };
}

/**
 * A failed service call. `code` is the service error code (e.g. `TOO_FAR`),
 * `NETWORK_ERROR` when the request did not complete, or `INVALID_RESPONSE`.
 */
export class DropsServiceError extends Error {
  readonly code: string;
  /** HTTP status; `0` for network failures. */
  readonly status: number;
  /** Delay requested by the response's `Retry-After` header in ms (`>= 0`), when present and valid. */
  readonly retryAfterMs: number | undefined;

  constructor(code: string, message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = 'DropsServiceError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Parses a `Retry-After` header value (delta-seconds or an HTTP date) into ms
 * from `now`. Returns `undefined` for a missing or invalid value; past dates give `0`.
 */
export function parseRetryAfterMs(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

const trimSlash = (url: string): string => url.replace(/\/+$/, '');

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function resolveFetch(config: DropsServiceConfig): FetchLike {
  if (config.fetch) return config.fetch;
  const f = (globalThis as { fetch?: FetchLike }).fetch;
  if (typeof f !== 'function') throw new DropsServiceError('NETWORK_ERROR', 'global fetch is not available', 0);
  return f;
}

async function call(config: DropsServiceConfig, path: string, method: 'GET' | 'POST', body?: unknown): Promise<unknown> {
  const fetchFn = resolveFetch(config);
  const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${config.apiKey}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchFn(`${trimSlash(config.baseUrl)}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    throw new DropsServiceError('NETWORK_ERROR', e instanceof Error ? e.message : String(e), 0);
  }
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    // Service errors are `{ error: { code, message } }`; tolerate a flat `{ code, message }`.
    const err = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : isRecord(parsed) ? parsed : {};
    const code = typeof err.code === 'string' ? err.code : `HTTP_${response.status}`;
    const message = typeof err.message === 'string' ? err.message : `request failed with status ${response.status}`;
    let retryAfter: string | null = null;
    try {
      retryAfter = response.headers?.get('Retry-After') ?? null;
    } catch {
      retryAfter = null;
    }
    throw new DropsServiceError(code, message, response.status, parseRetryAfterMs(retryAfter));
  }
  return parsed;
}

/** Fetches drops near a position (`GET /v1/drops/nearby`). Drops are validated against the protocol. */
export async function fetchNearbyDrops(config: DropsServiceConfig, query: NearbyDropsQuery): Promise<NearbyDropsResponse> {
  const params = [
    `lng=${encodeURIComponent(String(query.lng))}`,
    `lat=${encodeURIComponent(String(query.lat))}`,
    ...(query.radiusMeters !== undefined ? [`radius=${encodeURIComponent(String(query.radiusMeters))}`] : []),
    `channel=${encodeURIComponent(query.channel)}`,
  ].join('&');
  const body = await call(config, `/v1/drops/nearby?${params}`, 'GET');
  // openapi: `{ drops, generatedAt, expiresAt }`; a bare array is accepted too.
  const drops = Array.isArray(body) ? body : isRecord(body) ? body.drops : undefined;
  const check = validateEngineCommand({ type: 'setDropLayer', layerId: 'nearby', drops, collectRadiusMeters: 0 });
  if (!check.ok) throw new DropsServiceError('INVALID_RESPONSE', `invalid nearby drops: ${check.error}`, 200);
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    drops: drops as DropSpec[],
    generatedAt: isRecord(body) ? num(body.generatedAt) : null,
    expiresAt: isRecord(body) ? num(body.expiresAt) : null,
  };
}

/** Verifies a collection (`POST /v1/drops/collect`). Rejects with {@link DropsServiceError} (e.g. `422 TOO_FAR`). */
export async function verifyDropCollect(config: DropsServiceConfig, request: CollectVerifyRequest): Promise<CollectVerifyResponse> {
  const body = await call(config, '/v1/drops/collect', 'POST', request);
  if (!isRecord(body) || typeof body.receipt !== 'string') {
    throw new DropsServiceError('INVALID_RESPONSE', 'collect response has no receipt', 200);
  }
  return {
    receipt: body.receipt,
    replayed: body.replayed === true,
    collect: isRecord(body.collect)
      ? (body.collect as unknown as CollectVerifyResponse['collect'])
      : { dropId: request.dropId, collectId: request.collectId, userId: request.userId, collectedAt: request.fix.timestamp },
  };
}
