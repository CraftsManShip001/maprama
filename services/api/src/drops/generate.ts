/**
 * Deterministic drop placement.
 *
 * Drops are never stored. For a campaign, a time window index `w` and a
 * geohash cell, a seeded PRNG (`seed|w|cell`) yields the cell's drops, so
 * every client asking for the same area in the same window sees the same
 * drops, and verification can regenerate a drop from its id alone.
 *
 * Drop id: `d1.<campaignId>.<window>.<geohash>.<index>`.
 */
import { DROP_TYPES, RARITIES, haversineMeters, type DropSpec, type LngLat, type Rarity } from '@diorama/protocol';
import { DROP_LIMITS } from '../config.js';
import type { Campaign, DropArea } from '../deps.js';
import { seededRandom } from '../util/prng.js';
import {
  bboxAreaKm2,
  bboxContains,
  bboxIntersect,
  circleBbox,
  geohashBounds,
  geohashesInBbox,
  type Bbox,
} from '../util/geo.js';

export interface DropRef {
  campaignId: string;
  window: number;
  cell: string;
  index: number;
}

const ID_PREFIX = 'd1';
const CAMPAIGN_ID_RE = /^[A-Za-z0-9]{1,64}$/;
const CELL_RE = /^[0123456789bcdefghjkmnpqrstuvwxyz]{1,12}$/;

export function encodeDropId(ref: DropRef): string {
  return `${ID_PREFIX}.${ref.campaignId}.${ref.window}.${ref.cell}.${ref.index}`;
}

export function parseDropId(id: string): DropRef | null {
  if (typeof id !== 'string' || id.length > 128) return null;
  const parts = id.split('.');
  if (parts.length !== 5 || parts[0] !== ID_PREFIX) return null;
  const [, campaignId, w, cell, idx] = parts as [string, string, string, string, string];
  if (!CAMPAIGN_ID_RE.test(campaignId) || !CELL_RE.test(cell)) return null;
  if (!/^\d{1,9}$/.test(w) || !/^\d{1,6}$/.test(idx)) return null;
  return { campaignId, window: Number(w), cell, index: Number(idx) };
}

export function isValidCampaignId(id: string): boolean {
  return CAMPAIGN_ID_RE.test(id);
}

const windowMs = (c: Campaign): number => c.windowMinutes * 60_000;

/** Window index containing `atMs` (may be negative before the campaign starts). */
export function windowIndex(c: Campaign, atMs: number): number {
  return Math.floor((atMs - c.startsAtMs) / windowMs(c));
}

/** `[start, end)` of window `w`, clipped to the campaign's end. */
export function windowRange(c: Campaign, w: number): [number, number] {
  const start = c.startsAtMs + w * windowMs(c);
  return [start, Math.min(start + windowMs(c), c.endsAtMs)];
}

/** Whether window `w` exists (starts before the campaign ends). */
export function windowExists(c: Campaign, w: number): boolean {
  return w >= 0 && windowRange(c, w)[0] < c.endsAtMs;
}

/** The window live at `atMs`, or `null` outside the campaign. */
export function currentWindow(c: Campaign, atMs: number): number | null {
  if (atMs < c.startsAtMs || atMs >= c.endsAtMs) return null;
  return windowIndex(c, atMs);
}

export function areaBbox(area: DropArea): Bbox {
  return 'bbox' in area ? area.bbox : circleBbox(area.center, area.radiusMeters);
}

export function areaContains(area: DropArea, p: LngLat): boolean {
  return 'bbox' in area ? bboxContains(area.bbox, p) : haversineMeters(area.center, p) <= area.radiusMeters;
}

function pickRarity(weights: Campaign['rarityWeights'], r: number): Rarity {
  let total = 0;
  for (const k of RARITIES) total += Math.max(0, weights[k] ?? 0);
  if (total <= 0) return 'common';
  let acc = 0;
  const target = r * total;
  for (const k of RARITIES) {
    acc += Math.max(0, weights[k] ?? 0);
    if (target < acc) return k;
  }
  return RARITIES[RARITIES.length - 1]!;
}

/** Generates the drops of one campaign cell in window `w`, in index order. */
export function generateCellDrops(c: Campaign, w: number, cell: string): DropSpec[] {
  const bounds = geohashBounds(cell);
  if (!bounds || !windowExists(c, w)) return [];
  const areaBounds = areaBbox(c.area);
  if (!bboxIntersect(bounds, areaBounds)) return [];
  const rand = seededRandom(`${c.seed}|${w}|${cell}`);
  const expected = c.density * bboxAreaKm2(bounds);
  const count = Math.min(DROP_LIMITS.maxDropsPerCell, Math.floor(expected) + (rand() < expected % 1 ? 1 : 0));
  const out: DropSpec[] = [];
  for (let index = 0; index < count; index++) {
    // Always draw 4 numbers per slot so indices stay stable regardless of filtering.
    const rx = rand();
    const ry = rand();
    const rr = rand();
    const rp = rand();
    const coordinate = {
      lng: bounds[0] + rx * (bounds[2] - bounds[0]),
      lat: bounds[1] + ry * (bounds[3] - bounds[1]),
    };
    if (!areaContains(c.area, coordinate)) continue;
    const payload = c.payloadPool.length > 0 ? c.payloadPool[Math.floor(rp * c.payloadPool.length)]! : null;
    const drop: DropSpec = {
      id: encodeDropId({ campaignId: c.id, window: w, cell, index }),
      type: DROP_TYPES.includes(c.type) ? c.type : 'coin',
      coordinate,
      rarity: pickRarity(c.rarityWeights, rr),
      payload,
    };
    out.push(drop);
  }
  return out;
}

/** Regenerates one drop from its reference, or `null` if it does not exist. */
export function dropFromRef(c: Campaign, ref: DropRef): DropSpec | null {
  if (ref.campaignId !== c.id) return null;
  const id = encodeDropId(ref);
  return generateCellDrops(c, ref.window, ref.cell).find((d) => d.id === id) ?? null;
}

/** Drops of a campaign in its current window within `radiusMeters` of `center`, nearest first. */
export function nearbyDrops(c: Campaign, atMs: number, center: LngLat, radiusMeters: number): DropSpec[] {
  const w = currentWindow(c, atMs);
  if (w === null) return [];
  const query = bboxIntersect(circleBbox(center, radiusMeters), areaBbox(c.area));
  if (!query) return [];
  const cells = geohashesInBbox(query, DROP_LIMITS.geohashPrecision, 2000) ?? [];
  const out: { d: DropSpec; dist: number }[] = [];
  for (const cell of cells) {
    for (const d of generateCellDrops(c, w, cell)) {
      const dist = haversineMeters(center, d.coordinate);
      if (dist <= radiusMeters) out.push({ d, dist });
    }
  }
  out.sort((a, b) => a.dist - b.dist || (a.d.id < b.d.id ? -1 : 1));
  return out.map((x) => x.d);
}
