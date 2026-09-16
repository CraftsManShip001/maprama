/**
 * Joins Korean national building data (국가공간정보포털 GIS건물통합정보, exported
 * to GeoJSON in EPSG:4326) onto OSM footprints.
 *
 * Match rule per OSM footprint: the Korean polygon with the largest overlap
 * when it covers ≥ 50% of the OSM footprint area; otherwise the smallest Korean
 * polygon containing the OSM footprint centroid.
 *
 * The same rule, applied the other way round by {@link OsmFootprintIndex},
 * answers "is this Korean polygon already represented by an OSM building?" —
 * which is what `buildWorld({ krFillMissing: true })` needs before it emits a
 * building for a polygon OSM does not have.
 *
 * @module
 */

import { polygon as turfPolygon, featureCollection } from '@turf/helpers';
import { intersect } from '@turf/intersect';
import type { Projection, Vec2 } from '@maprama/protocol';
import type { ExternalHeight } from './classify.js';
import { parseLevels } from './classify.js';
import {
  dedupeConsecutive,
  openRing,
  pointInRing,
  pointsRect,
  rectsOverlap,
  ringArea,
  ringCentroid,
  type Rect,
} from './geometry.js';

/** Minimum share of the OSM footprint area that must overlap a Korean polygon. */
export const KR_MIN_OVERLAP = 0.5;

/** Property names (matched case-insensitively) read from each feature. */
export const KR_HEIGHT_KEYS = ['HEIGHT'];
export const KR_LEVEL_KEYS = ['GRND_FLR'];

/**
 * One indexed polygon of the national dataset. Exposed so `buildWorld` can use
 * the polygons as footprint sources, not only as height sources.
 */
export interface KrRecord extends ExternalHeight {
  /** Position in the index; also {@link KrMatch.index}. */
  index: number;
  /**
   * Stable key derived from the source lng/lat ring: independent of feature
   * order, of the projection and of the build options. See {@link krFeatureKey}.
   */
  key: string;
  /** Outer ring in world units: open, de-duplicated, neither simplified nor clipped. */
  ring: Vec2[];
  /** Axis-aligned bounds of {@link KrRecord.ring}. */
  rect: Rect;
  /** Ring area in world units². */
  area: number;
}

/** Match result. */
export interface KrMatch extends ExternalHeight {
  method: 'overlap' | 'centroid';
  overlap: number;
  /** {@link KrRecord.index} of the matched polygon. */
  index: number;
}

interface GeoJsonGeometry {
  type: string;
  coordinates?: unknown;
}
interface GeoJsonFeature {
  type?: string;
  geometry?: GeoJsonGeometry | null;
  properties?: Record<string, unknown> | null;
}

function readProp(props: Record<string, unknown> | null | undefined, keys: string[]): unknown {
  if (!props) return undefined;
  for (const [k, v] of Object.entries(props)) {
    if (keys.includes(k.toUpperCase())) return v;
  }
  return undefined;
}

function toNumber(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : undefined;
}

const CELL = 8; // world units per grid cell

function fnv1a(text: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * A 16 hex character key for a source polygon, hashed from its lng/lat ring
 * rounded to 7 decimals (≈ 1 cm). Two exports of the same unchanged building
 * produce the same key regardless of feature order, projection origin,
 * `unitMeters`, `simplifyMeters` or `precision`.
 */
export function krFeatureKey(outer: readonly (readonly [number, number])[]): string {
  const text = outer.map(([lng, lat]) => `${lng.toFixed(7)},${lat.toFixed(7)}`).join(';');
  const a = fnv1a(text, 0x811c9dc5).toString(16).padStart(8, '0');
  const b = fnv1a(text, 0x7b3f5a11).toString(16).padStart(8, '0');
  return `${a}${b}`;
}

/** Uniform grid over world-unit rectangles: maps a query rect to candidate ids. */
class Grid {
  private readonly cells = new Map<string, number[]>();

  add(id: number, rect: Rect): void {
    for (const key of cellsFor(rect)) {
      const list = this.cells.get(key);
      if (list) list.push(id);
      else this.cells.set(key, [id]);
    }
  }

  candidates(rect: Rect): number[] {
    const ids = new Set<number>();
    for (const key of cellsFor(rect)) for (const id of this.cells.get(key) ?? []) ids.add(id);
    return [...ids];
  }
}

/** Spatial index over Korean building polygons in world units. */
export class KrBuildingIndex {
  private readonly list: KrRecord[] = [];
  private readonly grid = new Grid();

  /** Number of indexed polygons. */
  get size(): number {
    return this.list.length;
  }

  /** Every indexed polygon, in input order. */
  get records(): readonly KrRecord[] {
    return this.list;
  }

  /**
   * Builds the index from a GeoJSON FeatureCollection (Polygon/MultiPolygon,
   * lng/lat). Features without usable height or floor data are skipped.
   */
  static fromGeoJson(geojson: unknown, projection: Projection): KrBuildingIndex {
    const index = new KrBuildingIndex();
    const features = (geojson as { features?: unknown })?.features;
    if (!Array.isArray(features)) throw new TypeError('kr buildings: expected a GeoJSON FeatureCollection');
    for (const f of features as GeoJsonFeature[]) {
      const geom = f?.geometry;
      if (!geom || !Array.isArray(geom.coordinates)) continue;
      const h = toNumber(readProp(f.properties, KR_HEIGHT_KEYS));
      const levels = parseLevels(toNumber(readProp(f.properties, KR_LEVEL_KEYS)));
      const heightMeters = h !== undefined && h > 0 ? h : undefined;
      if (heightMeters === undefined && levels === undefined) continue;
      const polys: unknown[] =
        geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? (geom.coordinates as unknown[]) : [];
      for (const poly of polys) {
        const outer = (poly as unknown[][])[0] as [number, number][] | undefined;
        if (!Array.isArray(outer)) continue;
        const ring = dedupeConsecutive(
          openRing(
            outer.map(([lng, lat]) => {
              const p = projection.toWorld({ lng, lat });
              return [p.x, p.z] as Vec2;
            }),
          ),
          true,
        );
        if (ring.length < 3) continue;
        const area = ringArea(ring);
        if (area <= 0) continue;
        index.add({ key: krFeatureKey(outer), ring, rect: pointsRect(ring), area, heightMeters, levels });
      }
    }
    return index;
  }

  private add(record: Omit<KrRecord, 'index'>): void {
    const index = this.list.length;
    this.list.push({ ...record, index });
    this.grid.add(index, record.rect);
  }

  private candidates(rect: Rect): KrRecord[] {
    return this.grid
      .candidates(rect)
      .map((id) => this.list[id]!)
      .filter((r) => rectsOverlap(r.rect, rect));
  }

  /** Finds the Korean record for an OSM footprint ring (world units, open). */
  match(ring: Vec2[]): KrMatch | undefined {
    const rect = pointsRect(ring);
    const candidates = this.candidates(rect);
    if (candidates.length === 0) return undefined;
    const area = ringArea(ring);
    let best: KrRecord | undefined;
    let bestOverlap = 0;
    if (area > 0) {
      for (const c of candidates) {
        const overlap = intersectionArea(ring, c.ring) / area;
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          best = c;
        }
      }
    }
    if (best && bestOverlap >= KR_MIN_OVERLAP) {
      return {
        heightMeters: best.heightMeters,
        levels: best.levels,
        method: 'overlap',
        overlap: bestOverlap,
        index: best.index,
      };
    }
    const centroid = ringCentroid(ring);
    const containing = candidates.filter((c) => pointInRing(centroid, c.ring)).sort((a, b) => a.area - b.area)[0];
    if (containing) {
      const overlap = area > 0 ? intersectionArea(ring, containing.ring) / area : 0;
      return {
        heightMeters: containing.heightMeters,
        levels: containing.levels,
        method: 'centroid',
        overlap,
        index: containing.index,
      };
    }
    return undefined;
  }
}

/**
 * Spatial index over the OSM footprints a build emitted, in world units.
 *
 * {@link OsmFootprintIndex.covers} is {@link KrBuildingIndex.match} read from
 * the other side: it answers whether a national-dataset polygon is already on
 * the map as an OSM building.
 */
export class OsmFootprintIndex {
  private readonly list: { ring: Vec2[]; rect: Rect }[] = [];
  private readonly grid = new Grid();

  /** Number of indexed footprints. */
  get size(): number {
    return this.list.length;
  }

  /** Adds a projected, open OSM footprint ring. */
  add(ring: Vec2[]): void {
    if (ring.length < 3) return;
    const rect = pointsRect(ring);
    this.grid.add(this.list.length, rect);
    this.list.push({ ring, rect });
  }

  /**
   * True when an OSM footprint covers at least {@link KR_MIN_OVERLAP} of
   * `ring`'s area, or when `ring`'s centroid falls inside an OSM footprint.
   */
  covers(ring: Vec2[]): boolean {
    const rect = pointsRect(ring);
    const candidates = this.grid
      .candidates(rect)
      .map((id) => this.list[id]!)
      .filter((c) => rectsOverlap(c.rect, rect));
    if (candidates.length === 0) return false;
    const area = ringArea(ring);
    if (area > 0) {
      for (const c of candidates) {
        if (intersectionArea(c.ring, ring) / area >= KR_MIN_OVERLAP) return true;
      }
    }
    const centroid = ringCentroid(ring);
    return candidates.some((c) => pointInRing(centroid, c.ring));
  }
}

function cellsFor(rect: Rect): string[] {
  const keys: string[] = [];
  const x0 = Math.floor(rect.minX / CELL);
  const x1 = Math.floor(rect.maxX / CELL);
  const z0 = Math.floor(rect.minZ / CELL);
  const z1 = Math.floor(rect.maxZ / CELL);
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) keys.push(`${x},${z}`);
  return keys;
}

function closed(ring: Vec2[]): [number, number][] {
  return [...ring.map((p) => [p[0], p[1]] as [number, number]), [ring[0]![0], ring[0]![1]]];
}

/** Planar intersection area of two simple rings (world units²). Returns 0 on failure. */
export function intersectionArea(a: Vec2[], b: Vec2[]): number {
  try {
    const result = intersect(featureCollection([turfPolygon([closed(a)]), turfPolygon([closed(b)])]));
    if (!result) return 0;
    const g = result.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    let total = 0;
    for (const poly of polys) {
      poly.forEach((ring, i) => {
        const area = ringArea(ring.slice(0, -1).map((p) => [p[0]!, p[1]!] as Vec2));
        total += i === 0 ? area : -area;
      });
    }
    return Math.max(0, total);
  } catch {
    return 0;
  }
}
