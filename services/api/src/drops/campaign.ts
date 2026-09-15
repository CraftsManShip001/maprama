import { DROP_TYPES, RARITIES, type DropType, type JsonValue, type Rarity } from '@maprama/protocol';
import { DROP_LIMITS } from '../config.js';
import type { CampaignSpec, DropArea } from '../deps.js';
import { badRequest } from '../errors.js';
import { isBbox, isLngLat } from '../util/geo.js';

const CHANNEL_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isJsonValue(v: unknown, depth = 0): v is JsonValue {
  if (depth > 32) return false;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => isJsonValue(x, depth + 1));
  if (isPlainObject(v)) return Object.values(v).every((x) => isJsonValue(x, depth + 1));
  return false;
}

function finite(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw badRequest(`"${name}" must be a number in [${min}, ${max}]`);
  return v;
}

function isoTime(v: unknown, name: string): number {
  if (typeof v !== 'string') throw badRequest(`"${name}" must be an ISO 8601 date-time string`);
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) throw badRequest(`"${name}" must be an ISO 8601 date-time string`);
  return ms;
}

/** Validates a campaign creation body. Throws `400 INVALID_REQUEST` with the offending field. */
export function parseCampaignSpec(body: unknown): CampaignSpec & { startsAtMs: number; endsAtMs: number } {
  if (!isPlainObject(body)) throw badRequest('Body must be a JSON object');
  const { channel, type, rarityWeights, payloadPool, area, density, windowMinutes, startsAt, endsAt, collectRadiusMeters } = body;

  if (typeof channel !== 'string' || !CHANNEL_RE.test(channel)) throw badRequest('"channel" must match ^[A-Za-z0-9_.:-]{1,64}$');
  if (typeof type !== 'string' || !(DROP_TYPES as readonly string[]).includes(type)) {
    throw badRequest(`"type" must be one of: ${DROP_TYPES.join(', ')}`);
  }
  if (type === 'model') throw badRequest('"type": "model" is not supported for campaigns yet (no model source field)');

  if (!isPlainObject(rarityWeights)) throw badRequest('"rarityWeights" must be an object');
  const weights: Partial<Record<Rarity, number>> = {};
  let total = 0;
  for (const [k, v] of Object.entries(rarityWeights)) {
    if (!(RARITIES as readonly string[]).includes(k)) throw badRequest(`"rarityWeights.${k}" is not a rarity (${RARITIES.join(', ')})`);
    weights[k as Rarity] = finite(v, `rarityWeights.${k}`, 0, 1e6);
    total += v as number;
  }
  if (total <= 0) throw badRequest('"rarityWeights" must have a positive total');

  if (!Array.isArray(payloadPool) || payloadPool.length === 0 || payloadPool.length > DROP_LIMITS.maxPayloadPool) {
    throw badRequest(`"payloadPool" must be a non-empty array of at most ${DROP_LIMITS.maxPayloadPool} JSON values`);
  }
  if (!payloadPool.every((p) => isJsonValue(p))) throw badRequest('"payloadPool" entries must be JSON values');
  if (new TextEncoder().encode(JSON.stringify(payloadPool)).length > DROP_LIMITS.maxPayloadBytes) {
    throw badRequest(`"payloadPool" must serialize to at most ${DROP_LIMITS.maxPayloadBytes} bytes`);
  }

  let parsedArea: DropArea;
  if (!isPlainObject(area)) throw badRequest('"area" must be {center, radiusMeters} or {bbox}');
  if ('bbox' in area) {
    if (!isBbox(area.bbox)) throw badRequest('"area.bbox" must be [west, south, east, north] with west < east and south < north');
    const [w, s, e, n] = area.bbox;
    if (e - w > 1 || n - s > 1) throw badRequest('"area.bbox" must span at most 1 degree in each direction');
    parsedArea = { bbox: [w, s, e, n] };
  } else {
    if (!isLngLat(area.center)) throw badRequest('"area.center" must be {lng, lat}');
    const r = finite(area.radiusMeters, 'area.radiusMeters', 1, DROP_LIMITS.maxAreaRadiusMeters);
    parsedArea = { center: { lng: area.center.lng, lat: area.center.lat }, radiusMeters: r };
  }

  const d = finite(density, 'density', 0.001, DROP_LIMITS.maxDensityPerKm2);
  const wm = finite(windowMinutes, 'windowMinutes', 1, DROP_LIMITS.maxWindowMinutes);
  if (!Number.isInteger(wm)) throw badRequest('"windowMinutes" must be an integer');
  const startsAtMs = isoTime(startsAt, 'startsAt');
  const endsAtMs = isoTime(endsAt, 'endsAt');
  if (endsAtMs <= startsAtMs) throw badRequest('"endsAt" must be after "startsAt"');
  const cr = finite(collectRadiusMeters, 'collectRadiusMeters', 1, DROP_LIMITS.maxCollectRadiusMeters);

  return {
    channel,
    type: type as DropType,
    rarityWeights: weights,
    payloadPool: payloadPool as JsonValue[],
    area: parsedArea,
    density: d,
    windowMinutes: wm,
    startsAt: new Date(startsAtMs).toISOString(),
    endsAt: new Date(endsAtMs).toISOString(),
    collectRadiusMeters: cr,
    startsAtMs,
    endsAtMs,
  };
}

export { isJsonValue, isPlainObject, CHANNEL_RE };
