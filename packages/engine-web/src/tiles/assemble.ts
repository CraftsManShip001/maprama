/**
 * Assembles the tiles that are currently loaded into one {@link WorldModel},
 * in world units relative to the render anchor.
 *
 * The engine's renderers, labels, picking, road graph and game systems all take
 * a `WorldModel`, and they are good. Rather than growing a second set of
 * per-tile renderers beside them, a tile world builds the same model out of the
 * loaded tiles and hands it to the same code. Two consequences worth stating
 * plainly:
 *
 * - **Everything a `data` world can do, a tile world can do**, with the same
 *   look, the same labels and the same `building:press`.
 * - **The model is rebuilt whenever the tile set or the anchor changes.** That
 *   is one visible cost (a rebuild takes as long as loading a city world does)
 *   and one large benefit: a re-base is the same operation as a tile change, so
 *   there is exactly one code path to get right instead of two.
 *
 * Because the anchor follows the camera, every coordinate in the assembled
 * model is within the loaded ring of the origin — a few hundred world units —
 * so the `Float32Array` vertex buffers the renderers bake are quantised at
 * well under a millimetre. That is the *other* half of why the anchor exists
 * (see `mercator.ts` for the first half, which is about the projection itself).
 *
 * @module
 */

import {

  type BuildingFootprint,
  type District,
  type LngLat,
  type MtilTile,
  type Poi,
  type Projection,
  type Station,
  type Vec2,
} from '@maprama/protocol';
import { buildGraph, type GraphRoad } from '../world/graph.js';
import { convertBuilding, hashId } from '../world/data.js';
import type { BuildingModel, WorldModel } from '../world/model.js';
import { normalizeRing } from '../world/polygon.js';
import { lngLatToMercator, mercatorToLngLat, metresPerUnitAt, tileBounds, type TileFrame } from './mercator.js';

/** One decoded tile plus the address it came from. */
export interface LoadedTile {
  z: number;
  x: number;
  y: number;
  /** `null` when the archive has no tile there: empty ground, not a failure. */
  tile: MtilTile | null;
}

/** Everything the assembler needs that does not come from the tiles themselves. */
export interface AssembleOptions {
  frame: TileFrame;
  /** Attribution lines resolved from the archive metadata table. */
  attribution: readonly string[];
  name: string;
  /** Where `world.start` should sit (the world point the camera opens on). */
  start?: { x: number; z: number };
}

/**
 * True when a polygon edge is an artefact of clipping rather than a real
 * boundary: both endpoints sit on the same side of the clip rectangle.
 *
 * `tile-format.md` §3.2 is explicit about why this matters. engine-web derives
 * a bank rim around every water polygon; a river cut at a tile edge would grow
 * a rim **down the middle of the river**, and the two halves of the river would
 * be separated by a green stripe. The rule costs no bytes because it is purely
 * geometric, and the price of a false positive is one missing metre of bank.
 *
 * The boundary to test against is the **clip rectangle**, `-buffer … extent +
 * buffer`, and not the tile rectangle `0 … extent`: geometry is cut to the tile
 * *plus* its buffer, so the cut edges lie at −256 and 8448. The spec was wrong
 * about this at first and was corrected once the pipeline measured it — on four
 * z15 tiles of the Han river the clip-rectangle rule finds 12 synthetic edges
 * and the `0`/`extent` rule finds **none**, which would put a wall across the
 * river while looking like it was handled.
 */
function isSyntheticEdge(a: Vec2, b: Vec2, extent: number, buffer: number): boolean {
  const lo = -buffer, hi = extent + buffer;
  const onSame = (i: 0 | 1, v: number): boolean => a[i] === v && b[i] === v;
  return onSame(0, lo) || onSame(0, hi) || onSame(1, lo) || onSame(1, hi);
}

/**
 * The rim polylines to draw around a water polygon: the ring split at every
 * synthetic edge. A polygon that was never cut comes back as the single closed
 * ring the renderer used before tiles existed.
 */
function waterRimsFor(ring: readonly Vec2[], local: readonly Vec2[], extent: number, buffer: number): Vec2[][] {
  const n = ring.length;
  if (n < 3) return [];
  const synthetic: boolean[] = new Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    synthetic[i] = isSyntheticEdge(local[i]!, local[(i + 1) % n]!, extent, buffer);
    if (synthetic[i]) any = true;
  }
  if (!any) return [[...ring, ring[0]!]];
  const out: Vec2[][] = [];
  let run: Vec2[] = [];
  // Walk the ring twice so a run that wraps past index 0 is emitted whole.
  for (let k = 0; k < n; k++) {
    const i = k;
    if (synthetic[i]) {
      if (run.length >= 2) out.push(run);
      run = [];
    } else {
      if (run.length === 0) run.push(ring[i]!);
      run.push(ring[(i + 1) % n]!);
    }
  }
  if (run.length >= 2) {
    // Join a trailing run with a leading one (the ring is cyclic).
    const first = out[0];
    if (first && !synthetic[n - 1] && first[0]![0] === run[run.length - 1]![0] && first[0]![1] === run[run.length - 1]![1]) {
      out[0] = [...run.slice(0, -1), ...first];
    } else out.push(run);
  }
  return out;
}

/** Converts every loaded tile into one world model anchored at `frame`'s anchor. */
export function assembleTileWorld(tiles: readonly LoadedTile[], opts: AssembleOptions): WorldModel {
  const { frame } = opts;
  const roads: GraphRoad[] = [];
  const footprints: BuildingFootprint[] = [];
  /** Metres-per-world-unit at each building's own tile, to scale its height. */
  const heightMeters: number[] = [];
  const buildingUnitMeters: number[] = [];
  const water: Vec2[][] = [];
  const waterRims: Vec2[][] = [];
  const parks: { name?: string; poly: Vec2[] }[] = [];
  const pois: Poi[] = [];
  const stations: Station[] = [];
  const districts: District[] = [];
  const pads: Vec2[][] = [];
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;

  for (const loaded of tiles) {
    const { z, x, y } = loaded;
    const n = 2 ** z;
    // Tile corners bound the world even when the tile is empty: a hole in the
    // archive is ground, and the ground plane has to reach it.
    const c0x = (x / n - frame.anchorMx) * frame.unitsPerMercator;
    const c0z = (y / n - frame.anchorMy) * frame.unitsPerMercator;
    const c1x = ((x + 1) / n - frame.anchorMx) * frame.unitsPerMercator;
    const c1z = ((y + 1) / n - frame.anchorMy) * frame.unitsPerMercator;
    if (c0x < minX) minX = c0x;
    if (c0z < minZ) minZ = c0z;
    if (c1x > maxX) maxX = c1x;
    if (c1z > maxZ) maxZ = c1z;
    const t = loaded.tile;
    if (!t) continue;

    const extent = t.extent;
    const place = frame.tilePlacement(z, x, y, extent);
    const toWorld = (p: readonly [number, number]): Vec2 => [place.originX + p[0] * place.scale, place.originZ + p[1] * place.scale];
    // The pad is drawn only where the archive actually has a tile, so a gap in
    // the data reads as open ground rather than as paving with nothing on it.
    pads.push([[c0x, c0z], [c1x, c0z], [c1x, c1z], [c0x, c1z]]);

    const b = tileBounds(z, x, y);
    const tileLat = (b.north + b.south) / 2;
    // Heights are real metres; world units are Mercator units true at `refLat`.
    // Scaling by the tile's own latitude keeps a building the right height
    // relative to the ground under it, which is what the eye compares.
    const unitMetersHere = metresPerUnitAt(frame.unitMeters, frame.refLat, tileLat);

    for (const r of t.layers.roads ?? []) {
      const g: GraphRoad = { id: r.id, cls: r.cls, pts: r.pts.map(toWorld) };
      if (r.name !== undefined) g.name = r.name;
      if (r.bridge) g.bridge = true;
      roads.push(g);
    }
    for (const f of t.layers.buildings ?? []) {
      footprints.push({ id: f.id, footprint: f.footprint.map(toWorld), height: 0, ...(f.levels !== undefined ? { levels: f.levels } : {}), ...(f.kind !== undefined ? { kind: f.kind } : {}), ...(f.name !== undefined ? { name: f.name } : {}) });
      heightMeters.push(f.heightDm / 10);
      buildingUnitMeters.push(unitMetersHere);
    }
    for (const f of t.layers.water ?? []) {
      // Normalised in **tile-local integers**, then mapped. The tile → world map
      // is affine with a positive scale on both axes, so it preserves winding
      // and the result is the same ring `normalizeRing` would have produced —
      // but the synthetic-edge test can then compare integers exactly instead of
      // asking whether 8447.999999996 is 8448.
      const local = normalizeRing(f.poly as unknown as Vec2[]);
      if (local.length < 3) continue;
      const ring = local.map(toWorld);
      water.push(ring);
      for (const rim of waterRimsFor(ring, local, extent, t.buffer)) waterRims.push(rim);
    }
    for (const f of t.layers.parks ?? []) {
      const poly = normalizeRing(f.poly.map(toWorld));
      if (poly.length < 3) continue;
      parks.push(f.name !== undefined ? { name: f.name, poly } : { poly });
    }
    for (const f of t.layers.pois ?? []) {
      const [px, pz] = toWorld([f.u, f.v]);
      // `buildingId` may name a building whose anchor is in another tile, which
      // may not be loaded. That is expected (tile-format.md §3.1): the reference
      // is kept and whoever resolves it treats "not found" as "no building".
      pois.push({
        id: f.id,
        name: f.name,
        cat: f.cat,
        x: px!,
        z: pz!,
        ...(f.buildingId !== undefined ? { buildingId: f.buildingId } : {}),
        ...(f.snapped ? { snapped: true, snapDistanceMeters: f.snapDistanceMeters ?? 0 } : {}),
      });
    }
    for (const f of t.layers.stations ?? []) {
      const [px, pz] = toWorld([f.u, f.v]);
      stations.push({ id: f.id, name: f.name, x: px!, z: pz! });
    }
    for (const f of t.layers.districts ?? []) {
      const [px, pz] = toWorld([f.u, f.v]);
      districts.push({ name: f.name, x: px!, z: pz!, ...(f.water ? { water: true } : {}) });
    }
  }

  const buildings: BuildingModel[] = [];
  for (let i = 0; i < footprints.length; i++) {
    const src = footprints[i]!;
    src.height = heightMeters[i]! / buildingUnitMeters[i]!;
    // The index seeds a building's massing, facade scheme and roof furniture.
    // In a `data` world it is the position in the document, which never
    // changes. In a tile world it would be the position in *whatever set of
    // tiles happens to be loaded* — so the same building would change shape as
    // its neighbours stream in, and again after every re-base. Seeding from the
    // id instead makes a building look the same however it got here.
    const b = convertBuilding(src, hashId(src.id));
    if (b) buildings.push(b);
  }

  if (!Number.isFinite(minX)) {
    minX = -1;
    minZ = -1;
    maxX = 1;
    maxZ = 1;
  }
  const start = opts.start ?? { x: 0, z: 0 };
  return {
    kind: 'tiles',
    name: opts.name,
    origin: frame.anchor,
    unitMeters: frame.anchorUnitMeters,
    projection: frameProjection(frame),
    bounds: { minX, minZ, maxX, maxZ },
    graph: buildGraph(roads),
    buildings,
    water,
    waterRims,
    waterRibbons: [],
    banks: [],
    pads,
    parks,
    plaza: null,
    gridBlocks: null,
    sceneryTrees: [],
    ground: 'paved',
    buildingBaseY: 0.06,
    pois,
    stations,
    districts,
    start,
    spawn: [],
    loopWays: [],
    attribution: [...opts.attribution],
  };
}

/**
 * A {@link Projection} over a {@link TileFrame}, so `project` / `unproject`,
 * `camera.center`, markers, drops and geofences all use the world's real frame.
 *
 * `unitMeters` is the ground metres per world unit **at the render anchor**.
 * Away from the anchor a Mercator unit covers slightly more or less ground
 * (`cos lat`), exactly as on every other web map; across South Korea that is a
 * 3.1 % spread, and since the anchor follows the camera the value is right
 * where distances are actually asked about.
 *
 * The snapshot is taken when the world is assembled, so a projection handed out
 * with one model keeps answering in that model's frame even after a re-base —
 * which is what makes the re-base atomic rather than half-applied.
 */
function frameProjection(frame: TileFrame): Projection {
  const anchor = frame.anchor;
  const anchorMx = frame.anchorMx;
  const anchorMy = frame.anchorMy;
  const unitsPerMercator = frame.unitsPerMercator;
  const unitMeters = frame.anchorUnitMeters;
  return {
    origin: Object.freeze({ lng: anchor.lng, lat: anchor.lat }),
    unitMeters,
    toWorld(lngLat) {
      const m = lngLatToMercator(lngLat.lng, lngLat.lat);
      return { x: (m.mx - anchorMx) * unitsPerMercator, z: (m.my - anchorMy) * unitsPerMercator };
    },
    toLngLat(point) {
      return mercatorToLngLat(anchorMx + point.x / unitsPerMercator, anchorMy + point.z / unitsPerMercator);
    },
    metersToUnits: (meters) => meters / unitMeters,
    unitsToMeters: (units) => units * unitMeters,
  };
}

/** The anchor a fresh tile world starts at. */
export const initialAnchor = (center: LngLat): LngLat => ({ lng: center.lng, lat: center.lat });
