/**
 * Overpass API client: query builder, endpoint fallback with retry/backoff,
 * and an on-disk response cache.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertBBox } from './build.js';
import type { BBox, OverpassResponse } from './types.js';

/** Default endpoints, tried in order (then again, with backoff). */
export const DEFAULT_OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/** Overpass servers reject requests without a User-Agent (HTTP 406). */
export const DEFAULT_USER_AGENT = 'diorama-osm/0.0.0 (Diorama world builder; Node.js)';

/** Parses `"south,west,north,east"`. */
export function parseBBox(text: string): BBox {
  const parts = text.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new RangeError(`invalid bbox "${text}" (expected south,west,north,east)`);
  }
  const [south, west, north, east] = parts as [number, number, number, number];
  const bbox = { south, west, north, east };
  assertBBox(bbox);
  return bbox;
}

/** Overpass QL for everything `buildWorld` consumes, with full geometry (`out geom`). */
export function buildOverpassQuery(bbox: BBox, timeoutSec = 180): string {
  assertBBox(bbox);
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const lines = [
    'way["building"]',
    'relation["building"]["type"="multipolygon"]',
    'way["highway"]',
    'way["natural"="water"]',
    'relation["natural"="water"]',
    'way["waterway"="riverbank"]',
    'relation["waterway"="riverbank"]',
    'way["water"="river"]',
    'relation["water"="river"]',
    'way["leisure"~"^(park|garden)$"]',
    'relation["leisure"~"^(park|garden)$"]',
    'way["landuse"~"^(grass|recreation_ground)$"]',
    'relation["landuse"~"^(grass|recreation_ground)$"]',
    'node["leisure"="park"]',
    'nwr["amenity"~"^(cafe|school|kindergarten)$"]',
    'nwr["shop"~"^(convenience|supermarket|music|books)$"]',
    'nwr["shop"]["name"~"LP|레코드|음반"]',
    'nwr["amenity"]["name"~"LP|레코드|음반"]',
    'node["railway"="station"]',
    'node["station"="subway"]',
    'node["place"~"^(square|neighbourhood|quarter|suburb)$"]',
    'way["place"="square"]',
  ];
  return `[out:json][timeout:${timeoutSec}];\n(\n${lines.map((l) => `  ${l}(${b});`).join('\n')}\n);\nout geom;\n`;
}

/** Options for {@link fetchOverpass}. */
export interface FetchOverpassOptions {
  /** Endpoints to try in order. Default: `$DIORAMA_OVERPASS_ENDPOINT` (comma-separated) or {@link DEFAULT_OVERPASS_ENDPOINTS}. */
  endpoints?: string[];
  /** User-Agent header. Default: `$DIORAMA_OSM_USER_AGENT` or {@link DEFAULT_USER_AGENT}. */
  userAgent?: string;
  /** Per-request timeout in ms. Default 90 000. */
  timeoutMs?: number;
  /** How many passes over the endpoint list. Default 2. */
  passes?: number;
  /** Base backoff in ms (doubles per attempt, capped at 30 s). Default 2000. */
  backoffMs?: number;
  /** Cache directory, or `null` to disable caching. */
  cacheDir?: string | null;
  /** Injected fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Injected sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Progress logger. */
  log?: (message: string) => void;
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** Cache file path for a query. */
export function cacheFileFor(cacheDir: string, query: string): string {
  return join(cacheDir, `overpass-${createHash('sha256').update(query).digest('hex').slice(0, 16)}.json`);
}

function envEndpoints(): string[] | undefined {
  const v = process.env.DIORAMA_OVERPASS_ENDPOINT;
  const list = v
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list && list.length > 0 ? list : undefined;
}

/**
 * Fetches OSM data for `bbox` from Overpass. Tries each endpoint in order
 * (POST, form field `data`), retrying transient failures with exponential
 * backoff. Successful responses are cached (keyed by query hash) and annotated
 * with `diorama: { bbox, endpoint, fetchedAt, query }`.
 */
export async function fetchOverpass(bbox: BBox, options: FetchOverpassOptions = {}): Promise<OverpassResponse> {
  const query = buildOverpassQuery(bbox);
  const log = options.log ?? (() => {});
  const cacheFile = options.cacheDir ? cacheFileFor(options.cacheDir, query) : undefined;
  if (cacheFile) {
    try {
      const cached = JSON.parse(await readFile(cacheFile, 'utf8')) as OverpassResponse;
      if (Array.isArray(cached.elements)) {
        log(`overpass: cache hit ${cacheFile}`);
        return cached;
      }
    } catch {
      // cache miss
    }
  }

  const endpoints = options.endpoints?.length ? options.endpoints : (envEndpoints() ?? DEFAULT_OVERPASS_ENDPOINTS);
  const userAgent = options.userAgent ?? process.env.DIORAMA_OSM_USER_AGENT ?? DEFAULT_USER_AGENT;
  const timeoutMs = options.timeoutMs ?? 90_000;
  const passes = Math.max(1, options.passes ?? 2);
  const backoffMs = options.backoffMs ?? 2000;
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const errors: string[] = [];
  let attempt = 0;
  for (let pass = 0; pass < passes; pass++) {
    for (const endpoint of endpoints) {
      if (attempt > 0) {
        const wait = Math.min(30_000, backoffMs * 2 ** (attempt - 1));
        log(`overpass: retrying in ${wait} ms`);
        await sleep(wait);
      }
      attempt++;
      try {
        log(`overpass: POST ${endpoint} (attempt ${attempt})`);
        const res = await doFetch(endpoint, {
          method: 'POST',
          headers: {
            'User-Agent': userAgent,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            Accept: 'application/json',
          },
          body: new URLSearchParams({ data: query }).toString(),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        if (!res.ok) {
          const retryable = res.status !== 400;
          throw new HttpError(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`, retryable);
        }
        let json: OverpassResponse;
        try {
          json = JSON.parse(text) as OverpassResponse;
        } catch {
          throw new HttpError(`non-JSON response: ${text.slice(0, 200)}`, true);
        }
        if (!Array.isArray(json.elements)) throw new HttpError('response has no elements[]', true);
        if (json.remark && /error|timed out|timeout|out of memory/i.test(json.remark)) {
          throw new HttpError(`incomplete result: ${json.remark}`, true);
        }
        json.diorama = { bbox, endpoint, fetchedAt: new Date().toISOString(), query };
        if (cacheFile && options.cacheDir) {
          await mkdir(options.cacheDir, { recursive: true });
          await writeFile(cacheFile, JSON.stringify(json));
          log(`overpass: cached ${cacheFile}`);
        }
        return json;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        errors.push(`${endpoint}: ${message}`);
        log(`overpass: ${endpoint} failed: ${message}`);
        if (e instanceof HttpError && !e.retryable) {
          throw new Error(`overpass: request rejected by ${endpoint}: ${message}`);
        }
      }
    }
  }
  throw new Error(`overpass: all endpoints failed:\n  ${errors.join('\n  ')}`);
}
