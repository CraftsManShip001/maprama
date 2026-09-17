/**
 * Geographic features -> MTIL tiles, following `design/tile-format.md` §3 and §4.
 *
 * Two ownership rules, and the whole no-seam story rests on which layer gets
 * which:
 *
 * - **Anchor-owned** (buildings, POIs, stations, districts): the tile containing
 *   the feature's anchor owns it and stores the geometry *whole*. A building is
 *   never cut, never seams, and never appears twice, so nothing downstream needs
 *   id-based de-duplication.
 * - **Clipped** (roads, water, parks): a single feature can cross the country, so
 *   it is clipped to the tile plus `buffer`. Clipping happens on the quantised
 *   integers, so the cut lands on a line both neighbours agree on.
 *
 * @module
 */

import {
  clipPolygon,
  clipPolyline,
  clipRect,
  dedupe,
  ringAnchor,
  ringAreaM2,
  type Pt,
} from './geometry.js';
import { lngLatToMercator, toGlobalLocal, type LngLat } from './mercator.js';
import { emptyLayers, LAYER_NAMES, type GeoBundle, type LayerName, type TileLayers } from './types.js';

/** A rectangle of tile addresses, inclusive. */
export interface TileWindow {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** One built tile, before encoding. */
export interface BuiltTile {
  z: number;
  x: number;
  y: number;
  layers: TileLayers;
  /** Ids of the sources that contributed a non-empty layer to this tile (§4.2). */
  sources: Set<string>;
}

/** What a tiling run cost, in the units `design/tile-format.md` reports. */
export interface TileStats {
  /** Largest distance, in tile units, that an anchor-owned feature sticks out past a tile edge. */
  buildingOverflowUnits: number;
  /** Pieces produced by clipping. */
  clippedParts: number;
  /** Features stored whole. */
  wholeFeatures: number;
}

/** Options for {@link tileBundle}. */
export interface TileBundleOptions {
  zoom: number;
  extent: number;
  buffer: number;
  /**
   * Only tiles inside this window are returned. Everything outside is built and
   * dropped — which is exactly what makes chunked building safe: a chunk is
   * extracted with a geographic margin so that features reaching into its core
   * tiles are complete, and the margin's own tiles belong to a neighbour.
   */
  window?: TileWindow;
  /** Which source supplied each layer, for the per-tile attribution indices. */
  origin: Readonly<Record<LayerName, string>>;
}

/** Result of {@link tileBundle}. */
export interface TileBundleResult {
  tiles: Map<string, BuiltTile>;
  stats: TileStats;
}

/** Thresholds the overview profile applies. */
export interface OverviewOptions {
  minBuildingHeightM?: number;
  minBuildingAreaM2?: number;
  minParkAreaM2?: number;
}

/**
 * The overview (z13) profile: what a zoomed-out level keeps.
 *
 * Small buildings, alleys, local streets and POIs are invisible at that scale
 * and are exactly what makes a low-zoom tile huge, so they are dropped. Note
 * that this is filtering only — no geometry simplification, which
 * `design/tile-format.md` §1.2 records as the untested next step.
 */
export function filterForOverview(geo: GeoBundle, options: OverviewOptions = {}): GeoBundle {
  const minHeightDm = (options.minBuildingHeightM ?? 30) * 10;
  const minAreaM2 = options.minBuildingAreaM2 ?? 1500;
  const minParkM2 = options.minParkAreaM2 ?? 5000;
  return {
    roads: geo.roads.filter((r) => r.cls === 'arterial'),
    buildings: geo.buildings.filter((b) => b.heightDm >= minHeightDm || ringAreaM2(b.footprint) >= minAreaM2),
    water: geo.water,
    parks: geo.parks.filter((p) => ringAreaM2(p.poly) >= minParkM2),
    pois: [],
    stations: geo.stations,
    districts: geo.districts,
  };
}

function inWindow(w: TileWindow | undefined, x: number, y: number): boolean {
  return !w || (x >= w.x0 && x <= w.x1 && y >= w.y0 && y <= w.y1);
}

/** Splits one region's features into tiles at a single zoom. */
export function tileBundle(geo: GeoBundle, options: TileBundleOptions): TileBundleResult {
  const { zoom: z, extent, buffer, window, origin } = options;
  const rect = clipRect(extent, buffer);
  const n = 2 ** z;
  const tiles = new Map<string, BuiltTile>();
  const stats: TileStats = { buildingOverflowUnits: 0, clippedParts: 0, wholeFeatures: 0 };

  const tileFor = (x: number, y: number, layer: LayerName): BuiltTile => {
    const key = `${x}/${y}`;
    let t = tiles.get(key);
    if (!t) {
      t = { z, x, y, layers: emptyLayers(), sources: new Set<string>() };
      tiles.set(key, t);
    }
    t.sources.add(origin[layer]);
    return t;
  };

  /** Quantise a ring/line once, into whole-zoom integers. */
  const globalOf = (pts: readonly LngLat[]): Pt[] => pts.map((p) => toGlobalLocal(p[0], p[1], z, extent));
  const localise = (pts: readonly Pt[], x: number, y: number): Pt[] => {
    const ox = x * extent;
    const oy = y * extent;
    return pts.map((p): Pt => [p[0] - ox, p[1] - oy]);
  };
  const clamp = (v: number): number => (v < 0 ? 0 : v > n - 1 ? n - 1 : v);
  const spanOf = (pts: readonly Pt[]): TileWindow => {
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of pts) {
      if (p[0] < minU) minU = p[0];
      if (p[0] > maxU) maxU = p[0];
      if (p[1] < minV) minV = p[1];
      if (p[1] > maxV) maxV = p[1];
    }
    return {
      x0: clamp(Math.floor(minU / extent)),
      x1: clamp(Math.floor(maxU / extent)),
      y0: clamp(Math.floor(minV / extent)),
      y1: clamp(Math.floor(maxV / extent)),
    };
  };
  const tileOfPoint = (p: LngLat): { x: number; y: number } => {
    const m = lngLatToMercator(p[0], p[1]);
    return { x: clamp(Math.floor(m.mx * n)), y: clamp(Math.floor(m.my * n)) };
  };

  // --- anchor-owned: whole geometry, exactly one tile -----------------------
  for (const b of geo.buildings) {
    const { x, y } = tileOfPoint(ringAnchor(b.footprint));
    if (!inWindow(window, x, y)) continue;
    const ring = dedupe(localise(globalOf(b.footprint), x, y));
    if (ring.length < 3) continue;
    for (const [u, v] of ring) {
      stats.buildingOverflowUnits = Math.max(stats.buildingOverflowUnits, -u, -v, u - extent, v - extent);
    }
    const { id, heightDm, levels, kind, name } = b;
    tileFor(x, y, 'buildings').layers.buildings.push({
      id,
      heightDm,
      ...(levels !== undefined ? { levels } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(name !== undefined ? { name } : {}),
      footprint: ring,
    });
    stats.wholeFeatures++;
  }
  for (const p of geo.pois) {
    const { x, y } = tileOfPoint(p.at);
    if (!inWindow(window, x, y)) continue;
    const [u, v] = localise(globalOf([p.at]), x, y)[0]!;
    const { id, name, cat, buildingId, snapped, snapDistanceMeters } = p;
    tileFor(x, y, 'pois').layers.pois.push({
      id,
      name,
      cat,
      ...(buildingId !== undefined ? { buildingId } : {}),
      ...(snapped ? { snapped, snapDistanceMeters } : {}),
      u,
      v,
    });
    stats.wholeFeatures++;
  }
  for (const s of geo.stations) {
    const { x, y } = tileOfPoint(s.at);
    if (!inWindow(window, x, y)) continue;
    const [u, v] = localise(globalOf([s.at]), x, y)[0]!;
    tileFor(x, y, 'stations').layers.stations.push({ id: s.id, name: s.name, u, v });
    stats.wholeFeatures++;
  }
  for (const d of geo.districts) {
    const { x, y } = tileOfPoint(d.at);
    if (!inWindow(window, x, y)) continue;
    const [u, v] = localise(globalOf([d.at]), x, y)[0]!;
    tileFor(x, y, 'districts').layers.districts.push({
      name: d.name,
      ...(d.water ? { water: true } : {}),
      u,
      v,
    });
    stats.wholeFeatures++;
  }

  // --- clipped layers -------------------------------------------------------
  const pad = Math.ceil(buffer / extent);
  for (const road of geo.roads) {
    const g = globalOf(road.pts);
    const span = spanOf(g);
    for (let x = clamp(span.x0 - pad); x <= clamp(span.x1 + pad); x++) {
      for (let y = clamp(span.y0 - pad); y <= clamp(span.y1 + pad); y++) {
        if (!inWindow(window, x, y)) continue;
        const pts = dedupe(localise(g, x, y));
        if (pts.length < 2) continue;
        const parts = clipPolyline(pts, rect);
        for (let i = 0; i < parts.length; i++) {
          tileFor(x, y, 'roads').layers.roads.push({
            id: parts.length > 1 ? `${road.id}#${i}` : road.id,
            cls: road.cls,
            ...(road.name !== undefined ? { name: road.name } : {}),
            ...(road.bridge ? { bridge: true } : {}),
            pts: parts[i]!,
          });
          stats.clippedParts++;
        }
      }
    }
  }
  for (const wtr of geo.water) {
    const g = globalOf(wtr.poly);
    const span = spanOf(g);
    for (let x = clamp(span.x0 - pad); x <= clamp(span.x1 + pad); x++) {
      for (let y = clamp(span.y0 - pad); y <= clamp(span.y1 + pad); y++) {
        if (!inWindow(window, x, y)) continue;
        const ring = dedupe(localise(g, x, y));
        if (ring.length < 3) continue;
        const clipped = clipPolygon(ring, rect);
        if (!clipped) continue;
        tileFor(x, y, 'water').layers.water.push({ poly: clipped });
        stats.clippedParts++;
      }
    }
  }
  for (const park of geo.parks) {
    const g = globalOf(park.poly);
    const span = spanOf(g);
    for (let x = clamp(span.x0 - pad); x <= clamp(span.x1 + pad); x++) {
      for (let y = clamp(span.y0 - pad); y <= clamp(span.y1 + pad); y++) {
        if (!inWindow(window, x, y)) continue;
        const ring = dedupe(localise(g, x, y));
        if (ring.length < 3) continue;
        const clipped = clipPolygon(ring, rect);
        if (!clipped) continue;
        tileFor(x, y, 'parks').layers.parks.push({
          ...(park.name !== undefined ? { name: park.name } : {}),
          poly: clipped,
        });
        stats.clippedParts++;
      }
    }
  }

  // A tile whose every layer is empty is not stored at all — §4.1. This is the
  // single biggest reason the national archive is small: most of the country is
  // mountain with no OSM features in it.
  for (const [key, t] of tiles) {
    if (LAYER_NAMES.every((name) => t.layers[name].length === 0)) tiles.delete(key);
  }
  return { tiles, stats };
}
