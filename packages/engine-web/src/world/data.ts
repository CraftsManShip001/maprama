/**
 * Real `WorldData` → internal {@link WorldModel} conversion, and resolution
 * of any {@link WorldSource} (inline data, URL, procedural).
 *
 * @module
 */

import { validateWorldData, type BuildingFootprint, type WorldData, type WorldSource } from '@maprama/protocol';
import { mulberry32 } from '../util/math.js';
import { buildGraph, type GraphRoad } from './graph.js';
import { buildGridWorld } from './grid.js';
import type { BuildingModel, WorldModel } from './model.js';
import { asRectangle, bbox, centroid, normalizeRing, signedArea } from './polygon.js';
import { autoShapeFor } from './shapes.js';
import { buildTownWorld } from './town.js';

/** Error thrown when a world cannot be loaded; `code` maps to the protocol error code. */
export class WorldLoadError extends Error {
  readonly code = 'world_load_failed';
  constructor(message: string) {
    super(message);
    this.name = 'WorldLoadError';
  }
}

/**
 * FNV-1a over a building id. Everything a building's *look* is randomised from
 * has to hang off this rather than off its position in an array, so the same
 * building looks the same however it got into the world.
 *
 * @internal
 */
export const hashId = (id: string): number => {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
};

/**
 * `BuildingFootprint` → {@link BuildingModel}: near-rectangles get oriented-rect
 * massing, everything else stacked massing, and the per-building randomness is
 * seeded from the id so the same building always looks the same.
 *
 * Exported for the tile world assembler (`tiles/assemble.ts`), which must
 * produce buildings that are indistinguishable from a `data` world's.
 *
 * @internal
 */
export function convertBuilding(src: BuildingFootprint, idx: number): BuildingModel | null {
  const ring = normalizeRing(src.footprint);
  if (ring.length < 3 || Math.abs(signedArea(ring)) < 0.01) return null;
  const rect = asRectangle(ring);
  const c = rect ? { x: rect.x, z: rect.z } : centroid(ring);
  const h = Math.max(0.2, src.height);
  const rnd = mulberry32(hashId(src.id));
  const kind = src.kind ?? (h > 5.0 ? 'glass' : h > 3.2 ? (rnd() < 0.55 ? 'apartment' : 'office') : rnd() < 0.5 ? 'brick' : 'office');
  const bb = bbox(ring);
  const w = rect ? rect.w : bb.maxX - bb.minX, d = rect ? rect.d : bb.maxZ - bb.minZ;
  const b: BuildingModel = {
    id: src.id,
    idx,
    x: c.x,
    z: c.z,
    yaw: rect ? rect.yaw : 0,
    rect: rect ? { w: rect.w, d: rect.d } : null,
    footprint: ring,
    h,
    kind,
    roof: 'flat',
    ci: hashId(src.id) % 6,
    decos: { sign: false, antenna: false, garden: false },
    autoShape: autoShapeFor(idx, h, w, d),
    landmark: false,
  };
  // arbitrary polygons only support stacked (scaled) massing
  if (!rect && (b.autoShape === 'L' || b.autoShape === 'twin')) b.autoShape = 'setback';
  if (src.levels !== undefined) b.levels = src.levels;
  if (src.name !== undefined) b.name = src.name;
  return b;
}

/**
 * Converts validated `WorldData` into the internal model: roads → planar
 * graph, footprints → buildings (near-rectangles get oriented-rect massing),
 * water/parks/POIs/stations/districts are kept for rendering and part-2
 * labels.
 *
 * Only what the document contains is rendered: a `plaza` becomes the plaza
 * disc and the default camera target, and never a building. (Earlier versions
 * synthesised a landmark tower over a plaza with nothing under it — a building
 * that does not exist in the source data. The procedural `town`/`grid` worlds
 * still generate their own landmark; those are not real-world data.)
 */
export function loadWorldData(world: WorldData): WorldModel {
  const roads: GraphRoad[] = world.roads.map((r) => {
    const g: GraphRoad = { id: r.id, cls: r.cls, pts: r.pts.map((p) => [p[0], p[1]]) };
    if (r.name !== undefined) g.name = r.name;
    if (r.bridge) g.bridge = true;
    return g;
  });
  const graph = buildGraph(roads);
  const buildings: BuildingModel[] = [];
  for (const src of world.buildings) {
    const b = convertBuilding(src, buildings.length);
    if (b) buildings.push(b);
  }
  const plaza: WorldModel['plaza'] = world.plaza ? { x: world.plaza.x, z: world.plaza.z, radius: 6.4 } : null;
  const { minX, minZ, maxX, maxZ } = world.bounds;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  return {
    kind: 'data',
    name: world.name,
    origin: { lng: world.origin.lng, lat: world.origin.lat },
    unitMeters: world.unitMeters,
    bounds: { ...world.bounds },
    graph,
    buildings,
    water: world.water.map((p) => normalizeRing(p)).filter((p) => p.length >= 3),
    waterRims: null,
    waterRibbons: [],
    banks: [],
    pads: [[[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]]],
    parks: world.parks.map((p) => (p.name !== undefined ? { name: p.name, poly: normalizeRing(p.poly) } : { poly: normalizeRing(p.poly) })),
    plaza,
    gridBlocks: null,
    sceneryTrees: [],
    ground: 'paved',
    buildingBaseY: 0.06,
    pois: world.pois.map((p) => ({ ...p })),
    stations: world.stations.map((s) => ({ ...s })),
    districts: world.districts.map((d) => ({ ...d })),
    start: world.plaza ? { x: world.plaza.x, z: world.plaza.z } : { x: cx, z: cz },
    spawn: [],
    loopWays: [],
    attribution: [...world.attribution],
  };
}

/** Minimal fetch signature (injectable for tests). */
export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Resolves a {@link WorldSource} into a {@link WorldModel}.
 *
 * @throws WorldLoadError when fetching, parsing or validation fails.
 */
export async function resolveWorldSource(source: WorldSource, fetchImpl?: FetchLike): Promise<WorldModel> {
  switch (source.kind) {
    case 'procedural':
      return source.layout === 'town' ? buildTownWorld(source.seed ?? 0) : buildGridWorld(source.seed ?? 0);
    case 'data':
      return loadWorldData(source.world);
    case 'url': {
      const f = fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
      if (!f) throw new WorldLoadError('fetch is not available to load the world URL');
      let json: unknown;
      try {
        const res = await f(source.url);
        if (!res.ok) throw new WorldLoadError(`HTTP ${res.status} while loading ${source.url}`);
        json = await res.json();
      } catch (e) {
        if (e instanceof WorldLoadError) throw e;
        throw new WorldLoadError(`failed to load ${source.url}: ${e instanceof Error ? e.message : String(e)}`);
      }
      const v = validateWorldData(json);
      if (!v.ok) throw new WorldLoadError(`invalid WorldData from ${source.url}: ${v.error}`);
      return loadWorldData(json as WorldData);
    }
    case 'tiles':
      // A streamed world is not a value you can resolve once: it owns an
      // archive, a render anchor and a tile budget for as long as the map is
      // up. The engine builds it through `TileWorld.open` instead (see
      // `tiles/world.ts`); reaching this line means a host bypassed the engine.
      throw new WorldLoadError("world source kind 'tiles' must be opened by the engine (TileWorld.open), not resolved");
  }
}
