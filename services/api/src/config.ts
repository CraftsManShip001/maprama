import type { Plan, UsageUnit } from './deps.js';

/** All billable unit kinds. */
export const USAGE_UNITS: readonly UsageUnit[] = ['tile', 'world', 'search', 'transit', 'drops', 'collect'];

/**
 * Billable units charged per successful request (status < 400, or 422 for
 * collect verification which does the full work). Tiles are the cheapest
 * because a map view loads dozens of them; a world JSON is a large download.
 */
export const UNIT_WEIGHTS: Readonly<Record<UsageUnit, number>> = {
  tile: 1,
  world: 20,
  search: 5,
  transit: 2,
  drops: 2,
  collect: 10,
};

/** Default monthly quota (billable units) by plan, used when creating keys. */
export const PLAN_DEFAULT_QUOTA: Readonly<Record<Plan, number>> = {
  free: 50_000,
  pro: 2_000_000,
};

/** Collect verification rules. */
export const COLLECT_RULES = {
  /** Maximum accuracy radius credited towards the collect radius. */
  maxAccuracyBonusMeters: 30,
  /** Allowed difference between fix timestamp and server clock. */
  maxClockSkewMs: 2 * 60 * 1000,
  /** Maximum implied speed between two verified collects (90 m/s = 324 km/h: subway/car ok, teleports rejected). */
  maxSpeedMps: 90,
  /** Minimum time delta used for speed computation, avoids division by ~0. */
  minSpeedDeltaMs: 1000,
} as const;

/** Drop generation limits. */
export const DROP_LIMITS = {
  geohashPrecision: 6,
  maxNearbyRadiusMeters: 3000,
  defaultNearbyRadiusMeters: 500,
  maxDropsPerCell: 500,
  maxDensityPerKm2: 1000,
  maxAreaRadiusMeters: 50_000,
  maxWindowMinutes: 24 * 60,
  maxCollectRadiusMeters: 500,
  maxPayloadPool: 1000,
  maxPayloadBytes: 64 * 1024,
} as const;

/** Search limits. */
export const SEARCH_LIMITS = {
  defaultLimit: 10,
  maxLimit: 50,
  maxQueryLength: 100,
  /** Weight of proximity in the blended score when `near` is given. */
  proximityWeight: 0.3,
  /** Distance (m) at which proximity score halves. */
  proximityHalfMeters: 1000,
  reverseMaxRadiusMeters: 200,
} as const;

export const TRANSIT_LIMITS = {
  maxStations: 500,
} as const;

export const WEBHOOK_DEFAULTS = {
  attempts: 3,
  backoffMs: [1000, 4000],
  timeoutMs: 8000,
} as const;

/** Blob keys. */
export const BLOB_KEYS = {
  world: (region: string) => `worlds/${region}.json`,
  tiles: (tileset: string) => `tiles/${tileset}.pmtiles`,
} as const;

/** Maximum JSON body size for POST endpoints. */
export const MAX_BODY_BYTES = 256 * 1024;
