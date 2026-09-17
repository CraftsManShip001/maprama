/**
 * The OpenStreetMap source: a national `.osm.pbf` in, `GeoBundle`s out.
 *
 * The only interesting thing it does is batching. `@maprama/osm`'s
 * `extractFromPbf(file, bboxes[])` serves **N areas from one scan of the file**,
 * and a nationwide build has hundreds of regions: calling the single-bbox path
 * per region would re-read a 287 MB file hundreds of times. So
 * {@link OsmPbfSource.prepare} is given the whole batch and does exactly one
 * scan for it, and {@link OsmPbfSource.load} then only runs `buildWorld`.
 *
 * Raw payloads are converted to `GeoBundle`s inside `prepare` and dropped as
 * they are converted: the Overpass-shaped raw of a dense region is an order of
 * magnitude larger than the world built from it, and holding a whole batch of
 * them is what would actually blow the heap.
 *
 * @module
 */

import { buildWorld, KR_ATTRIBUTION, OSM_ATTRIBUTION, extractFromPbf, type BBox } from '@maprama/osm';
import type { WorldData } from '@maprama/protocol';
import { worldToLngLat, type LngLat } from './mercator.js';
import type { Region, TileSource } from './sources.js';
import { emptyBundle, LAYER_NAMES, type GeoBundle, type LayerName } from './types.js';

/** Options for {@link OsmPbfSource}. */
export interface OsmPbfSourceOptions {
  /** Path to the national `.osm.pbf` extract. */
  file: string;
  /** Douglas–Peucker tolerance in metres, passed to `buildWorld`. Default 0.5. */
  simplifyMeters?: number;
  /** Metres per world unit used while building. Default 8 (the `WorldData` default). */
  unitMeters?: number;
  /** Parsed GeoJSON of the Korean national building dataset, for heights. */
  krBuildings?: unknown;
  /** Also emit buildings for national-dataset polygons OSM does not have. */
  krFillMissing?: boolean;
  /** Progress logger. */
  log?: (message: string) => void;
}

const asBBox = (b: Region['padded']): BBox => ({ west: b.west, south: b.south, east: b.east, north: b.north });

/** `WorldData` -> lng/lat features, keeping ids, tags and the decimetre heights §4.1 asks for. */
export function worldToGeo(world: WorldData): GeoBundle {
  const { origin, unitMeters } = world;
  const pt = (x: number, z: number): LngLat => worldToLngLat(origin, unitMeters, x, z);
  const line = (pts: readonly (readonly [number, number])[]): LngLat[] => pts.map(([x, z]) => pt(x, z));
  return {
    roads: world.roads.map((r) => ({
      id: r.id,
      cls: r.cls,
      ...(r.name !== undefined ? { name: r.name } : {}),
      ...(r.bridge ? { bridge: true as const } : {}),
      pts: line(r.pts),
    })),
    buildings: world.buildings.map((b) => ({
      id: b.id,
      heightDm: Math.max(0, Math.round(b.height * unitMeters * 10)),
      ...(b.levels !== undefined ? { levels: b.levels } : {}),
      ...(b.kind !== undefined ? { kind: b.kind } : {}),
      ...(b.name !== undefined ? { name: b.name } : {}),
      footprint: line(b.footprint),
    })),
    water: world.water.map((poly) => ({ poly: line(poly) })),
    parks: world.parks.map((p) => ({ ...(p.name !== undefined ? { name: p.name } : {}), poly: line(p.poly) })),
    pois: world.pois.map((p) => ({
      id: p.id,
      name: p.name,
      cat: p.cat,
      ...(p.buildingId !== undefined ? { buildingId: p.buildingId } : {}),
      ...(p.snapped ? { snapped: true as const, snapDistanceMeters: p.snapDistanceMeters } : {}),
      at: pt(p.x, p.z),
    })),
    stations: world.stations.map((s) => ({ id: s.id, name: s.name, at: pt(s.x, s.z) })),
    districts: world.districts.map((d) => ({
      name: d.name,
      ...(d.water ? { water: true as const } : {}),
      at: pt(d.x, d.z),
    })),
  };
}

/** The `osm` source. */
export class OsmPbfSource implements TileSource {
  readonly id = 'osm';
  readonly provides: readonly LayerName[] = LAYER_NAMES;
  readonly attribution: readonly string[];

  #cache = new Map<string, GeoBundle>();
  #log: (message: string) => void;

  constructor(readonly options: OsmPbfSourceOptions) {
    this.attribution = options.krBuildings ? [OSM_ATTRIBUTION, KR_ATTRIBUTION] : [OSM_ATTRIBUTION];
    this.#log = options.log ?? ((): void => {});
  }

  /** One `.pbf` scan for the whole batch; the raws are turned into worlds and released as we go. */
  async prepare(regions: readonly Region[]): Promise<void> {
    this.#cache.clear();
    if (regions.length === 0) return;
    const results = await extractFromPbf(
      this.options.file,
      regions.map((r) => asBBox(r.padded)),
      { log: this.#log },
    );
    for (let i = 0; i < results.length; i++) {
      const region = regions[i]!;
      const result = results[i]!;
      const world = buildWorld(result.raw, {
        name: region.id,
        bbox: asBBox(region.padded),
        origin: {
          lng: (region.padded.west + region.padded.east) / 2,
          lat: (region.padded.south + region.padded.north) / 2,
        },
        ...(this.options.unitMeters !== undefined ? { unitMeters: this.options.unitMeters } : {}),
        ...(this.options.simplifyMeters !== undefined ? { simplifyMeters: this.options.simplifyMeters } : {}),
        ...(this.options.krBuildings !== undefined ? { krBuildings: this.options.krBuildings } : {}),
        ...(this.options.krFillMissing !== undefined ? { krFillMissing: this.options.krFillMissing } : {}),
      });
      this.#cache.set(region.id, worldToGeo(world));
      // Release the raw payload before building the next region: a dense
      // region's raw is several hundred MB and the batch holds them all.
      (results as unknown[])[i] = undefined;
    }
  }

  async load(region: Region): Promise<GeoBundle> {
    const hit = this.#cache.get(region.id);
    if (hit) return hit;
    // Not prepared as part of a batch (a single-region run): do the one-bbox scan.
    await this.prepare([region]);
    return this.#cache.get(region.id) ?? emptyBundle();
  }

  release(): void {
    this.#cache.clear();
  }
}
