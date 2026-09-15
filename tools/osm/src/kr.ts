/**
 * Joins Korean national building data (국가공간정보포털 GIS건물통합정보, exported
 * to GeoJSON in EPSG:4326) onto OSM footprints.
 *
 * Match rule per OSM footprint: the Korean polygon with the largest overlap
 * when it covers ≥ 50% of the OSM footprint area; otherwise the smallest Korean
 * polygon containing the OSM footprint centroid.
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

interface KrRecord extends ExternalHeight {
  ring: Vec2[];
  rect: Rect;
  area: number;
}

/** Match result. */
export interface KrMatch extends ExternalHeight {
  method: 'overlap' | 'centroid';
  overlap: number;
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

/** Spatial index over Korean building polygons in world units. */
export class KrBuildingIndex {
  private readonly records: KrRecord[] = [];
  private readonly grid = new Map<string, number[]>();

  /** Number of indexed polygons. */
  get size(): number {
    return this.records.length;
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
        index.add({ ring, rect: pointsRect(ring), area, heightMeters, levels });
      }
    }
    return index;
  }

  private add(record: KrRecord): void {
    const id = this.records.push(record) - 1;
    for (const key of cellsFor(record.rect)) {
      const list = this.grid.get(key);
      if (list) list.push(id);
      else this.grid.set(key, [id]);
    }
  }

  private candidates(rect: Rect): KrRecord[] {
    const ids = new Set<number>();
    for (const key of cellsFor(rect)) for (const id of this.grid.get(key) ?? []) ids.add(id);
    return [...ids].map((id) => this.records[id]!).filter((r) => rectsOverlap(r.rect, rect));
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
      return { heightMeters: best.heightMeters, levels: best.levels, method: 'overlap', overlap: bestOverlap };
    }
    const centroid = ringCentroid(ring);
    const containing = candidates.filter((c) => pointInRing(centroid, c.ring)).sort((a, b) => a.area - b.area)[0];
    if (containing) {
      const overlap = area > 0 ? intersectionArea(ring, containing.ring) / area : 0;
      return { heightMeters: containing.heightMeters, levels: containing.levels, method: 'centroid', overlap };
    }
    return undefined;
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
