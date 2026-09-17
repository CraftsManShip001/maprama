/**
 * The `kr-parks` source: Korean national city-planning facility data instead of
 * OpenStreetMap for the `parks` layer.
 *
 * ## What the data is
 *
 * 토지이음 (도시계획)시설정보, 국토교통부 — the polygons of every facility fixed
 * by a city-planning decision, published per province as shapefiles in
 * EPSG:5174. Layer `UQ153` (공간시설) is the one that holds open space. It is
 * published under 공공누리 제1유형 (출처표시), which is attribution-only: no
 * share-alike, commercial use allowed. Attribution is therefore *obligatory*,
 * which is what {@link KR_PARKS_ATTRIBUTION} and the per-tile attribution
 * indices exist for.
 *
 * ## Why it is not simply "better OSM"
 *
 * It is a *legal* dataset, not a survey of what is on the ground: it contains
 * what a plan designated, including 완충녹지 (the strip of planting a road is
 * required to have) and 공공공지 (a few square metres of mandated setback).
 * Drawing all of those as parks turns a city green along its roads. Which code
 * groups count as a park is therefore a rendering decision, taken by
 * {@link ConvertKrParksOptions.groups}; see `docs/` and the commit message for
 * what the screenshots showed.
 *
 * ## Shape of the integration
 *
 * Conversion is offline and one-off (`maprama-tiles kr-parks`), because it reads
 * 106 MB of `.shp` and 310 MB of `.dbf` and does not change between builds. The
 * build-time half, {@link KrParksSource}, only loads the converted file and
 * answers regions from a bbox index — which is what lets it satisfy
 * {@link TileSource} without a `prepare` hook.
 *
 * @module
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { epsg5174ToWgs84 } from './kr-proj.js';
import { readDbf, readPolygonShapefile, signedArea } from './shapefile.js';
import type { LngLat } from './mercator.js';
import type { Region, TileSource } from './sources.js';
import { emptyBundle, type GeoBundle, type GeoPark, type LayerName } from './types.js';

/**
 * The attribution line 공공누리 제1유형 obliges us to carry. Every tile that
 * gets a park polygon from this source stores this line's index (§4.2).
 */
export const KR_PARKS_ATTRIBUTION = '공원: 토지이음 (도시계획)시설정보 — 국토교통부 (공공누리 제1유형)';

/** The code groups of layer `UQ153`, keyed by the leaf-code prefix. */
export const KR_PARK_GROUPS = {
  /** `UQT1` 광장 — plazas. Paved, not green. */
  plaza: 'UQT1',
  /** `UQT2` 공원 — parks proper: 근린/어린이/소/문화/역사/체육/수변/도시자연공원. */
  park: 'UQT2',
  /** `UQT3` 녹지 — 완충/경관/연결녹지: planting strips beside roads and rail. */
  green: 'UQT3',
  /** `UQT4` 유원지 — amusement/recreation grounds. */
  amusement: 'UQT4',
  /** `UQT5` 공공공지 — small mandated public open space. */
  openspace: 'UQT5',
} as const;

/** One of the {@link KR_PARK_GROUPS} keys. */
export type KrParkGroup = keyof typeof KR_PARK_GROUPS;

/** Groups drawn as a park by default: 공원 and 유원지. */
export const DEFAULT_KR_PARK_GROUPS: readonly KrParkGroup[] = ['park', 'amusement'];

/**
 * Smallest polygon kept, in square metres.
 *
 * 200 m² is a 14 m square. Below that a park polygon is smaller than the
 * buildings it sits between, so it cannot read as open space at any zoom the
 * archive stores — it reads as a stray green dot. It is also where this
 * dataset's own noise lives: the sub-200 m² records are almost entirely
 * 공공공지 slivers and fragments left by parcel edits.
 */
export const DEFAULT_KR_PARK_MIN_AREA_M2 = 200;

/** Names that rescue a record whose three classification columns are all blank. */
const RESCUE_BY_NAME: Record<KrParkGroup, RegExp> = {
  plaza: /광장/,
  park: /공원/,
  green: /녹지/,
  amusement: /유원지/,
  openspace: /공공공지/,
};

/** Options for {@link convertKrParks}. */
export interface ConvertKrParksOptions {
  /** Directory holding the per-province directories of unpacked `*_C_UQ153.*`. */
  dir: string;
  /** Which code groups become parks. Default {@link DEFAULT_KR_PARK_GROUPS}. */
  groups?: readonly KrParkGroup[];
  /** Default {@link DEFAULT_KR_PARK_MIN_AREA_M2}. */
  minAreaM2?: number;
  /**
   * Also keep records whose classification columns are all blank but whose
   * `DGM_NM` names one of the chosen groups. 7,827 records in the 2026-08 issue
   * are in that state. Default true.
   */
  rescueByName?: boolean;
  log?: (message: string) => void;
}

/** What {@link convertKrParks} measured on the way through. */
export interface KrParksStats {
  files: number;
  records: number;
  /** Records whose leaf code is in one of the chosen groups. */
  matched: number;
  /** Records with no code at all that `DGM_NM` put into a chosen group. */
  rescued: number;
  /** Outer rings produced (a multipart record produces several). */
  rings: number;
  droppedSmall: number;
  droppedDuplicate: number;
  /** Inner rings discarded: `GeoPark` has no hole. */
  droppedHoles: number;
  kept: number;
  areaKm2: number;
}

/** A converted park file: what `maprama-tiles kr-parks` writes and {@link KrParksSource} reads. */
export interface KrParksFile {
  format: 'maprama-kr-parks-1';
  attribution: string;
  groups: readonly string[];
  minAreaM2: number;
  stats: KrParksStats;
  /** `[name, lng0, lat0, lng1, lat1, ...]`; an empty name means the record had none. */
  parks: [string, ...number[]][];
}

const upper = (row: Record<string, string>, key: string): string => row[key] ?? row[key.toLowerCase()] ?? '';

/** The leaf classification code: the last non-empty of the three columns (they are not always aligned). */
function leafCode(row: Record<string, string>): string {
  const cols = [upper(row, 'LCLAS_CL'), upper(row, 'MLSFC_CL'), upper(row, 'SCLAS_CL')].filter((v) => v !== '');
  return cols.length > 0 ? cols[cols.length - 1]! : '';
}

/** Rounds to ~1 cm, for the de-duplication key. */
const k7 = (n: number): string => n.toFixed(7);

/**
 * Reads every `*_C_UQ153` shapefile under `dir` and returns the park polygons in
 * WGS 84, ready to be a `GeoBundle.parks`.
 *
 * The transform, in order: leaf-code filter -> multipart split -> outer rings
 * only -> EPSG:5174 to WGS 84 -> drop small -> de-duplicate. Area is measured in
 * the *source* projection, which is metric, so it is a true square-metre figure
 * and not a latitude-dependent approximation.
 */
export async function convertKrParks(
  options: ConvertKrParksOptions,
): Promise<{ parks: GeoPark[]; stats: KrParksStats }> {
  const log = options.log ?? ((): void => {});
  const groups = options.groups ?? DEFAULT_KR_PARK_GROUPS;
  const minArea = options.minAreaM2 ?? DEFAULT_KR_PARK_MIN_AREA_M2;
  const rescue = options.rescueByName ?? true;
  const prefixes = groups.map((g) => KR_PARK_GROUPS[g]);
  const rescuers = groups.map((g) => RESCUE_BY_NAME[g]);

  const stats: KrParksStats = {
    files: 0,
    records: 0,
    matched: 0,
    rescued: 0,
    rings: 0,
    droppedSmall: 0,
    droppedDuplicate: 0,
    droppedHoles: 0,
    kept: 0,
    areaKm2: 0,
  };
  const parks: GeoPark[] = [];
  const seen = new Set<string>();

  const entries = (await readdir(options.dir, { withFileTypes: true })).filter((e) => e.isDirectory()).sort();
  for (const entry of entries) {
    const dir = join(options.dir, entry.name);
    const bases = (await readdir(dir))
      .filter((f) => f.toUpperCase().endsWith('_C_UQ153.SHP'))
      .map((f) => join(dir, f.slice(0, -4)))
      .sort();
    for (const base of bases) {
      stats.files++;
      const shapes = await readPolygonShapefile(`${base}.shp`);
      const rows = await readDbf(`${base}.dbf`);
      for (let i = 0; i < shapes.length; i++) {
        const shape = shapes[i]!;
        const row = rows[i] ?? {};
        stats.records++;
        if (shape.parts.length === 0 || row['_deleted'] === '1') continue;

        const name = upper(row, 'DGM_NM');
        const leaf = leafCode(row);
        let take = false;
        if (leaf !== '') {
          take = prefixes.some((p) => leaf.startsWith(p));
          if (take) stats.matched++;
        } else if (rescue && name !== '') {
          take = rescuers.some((re) => re.test(name));
          if (take) stats.rescued++;
        }
        if (!take) continue;

        for (const ring of shape.parts) {
          // Shapefile rule: outer ring clockwise (negative area here), hole
          // counter-clockwise. A `GeoPark` cannot express a hole, so a hole is
          // dropped rather than drawn as a second park.
          const area = signedArea(ring);
          if (area >= 0) {
            stats.droppedHoles++;
            continue;
          }
          stats.rings++;
          const areaM2 = -area;
          if (areaM2 < minArea) {
            stats.droppedSmall++;
            continue;
          }
          // Shapefile rings are closed; `GeoPark.poly` is open.
          const closed = ring.length > 1 && ring[0]![0] === ring[ring.length - 1]![0] && ring[0]![1] === ring[ring.length - 1]![1];
          const open = closed ? ring.slice(0, -1) : ring;
          if (open.length < 3) continue;
          const poly: LngLat[] = open.map(([x, y]) => epsg5174ToWgs84(x, y));
          // The same park is issued twice where KLIP and UPIS overlap, and some
          // provinces carry a decision twice. Key on the geometry, not the name.
          const key = `${name}|${k7(poly[0]![0])},${k7(poly[0]![1])}|${poly.length}|${areaM2.toFixed(1)}`;
          if (seen.has(key)) {
            stats.droppedDuplicate++;
            continue;
          }
          seen.add(key);
          parks.push(name === '' ? { poly } : { name, poly });
          stats.kept++;
          stats.areaKm2 += areaM2 / 1e6;
        }
      }
      log(`kr-parks: ${base} -> ${stats.kept} kept so far`);
    }
  }
  return { parks, stats };
}

/** Packs converted parks into the on-disk form. */
export function encodeKrParksFile(
  parks: readonly GeoPark[],
  stats: KrParksStats,
  groups: readonly string[],
  minAreaM2: number,
): KrParksFile {
  return {
    format: 'maprama-kr-parks-1',
    attribution: KR_PARKS_ATTRIBUTION,
    groups: [...groups],
    minAreaM2,
    stats,
    // Coordinates are rounded to 1e-7 degrees (~1 cm) — far finer than the
    // 0.118 m a z15 tile unit is worth, and it halves the file.
    parks: parks.map((p) => {
      const flat: number[] = [];
      for (const [lng, lat] of p.poly) flat.push(Number(lng.toFixed(7)), Number(lat.toFixed(7)));
      return [p.name ?? '', ...flat] as [string, ...number[]];
    }),
  };
}

/** Bounding box of a ring. */
interface Box {
  west: number;
  south: number;
  east: number;
  north: number;
}

function boxOf(poly: readonly LngLat[]): Box {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lng, lat] of poly) {
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return { west, south, east, north };
}

/** Options for {@link KrParksSource}. */
export interface KrParksSourceOptions {
  /** Path to the file `maprama-tiles kr-parks` wrote. */
  file: string;
  log?: (message: string) => void;
}

/**
 * The `kr-parks` source. Provides the `parks` layer only; everything else stays
 * wherever the routing had it.
 */
export class KrParksSource implements TileSource {
  readonly id = 'kr-parks';
  readonly provides: readonly LayerName[] = ['parks'];
  readonly attribution: readonly string[] = [KR_PARKS_ATTRIBUTION];

  #parks: GeoPark[] = [];
  #boxes: Box[] = [];
  #loaded = false;
  #log: (message: string) => void;

  constructor(readonly options: KrParksSourceOptions) {
    this.#log = options.log ?? ((): void => {});
  }

  /** Reads the converted file once. Cheap enough to do on the first region too. */
  async prepare(): Promise<void> {
    if (this.#loaded) return;
    const file = JSON.parse(await readFile(this.options.file, 'utf8')) as KrParksFile;
    if (file.format !== 'maprama-kr-parks-1') {
      throw new Error(`${this.options.file}: not a maprama-kr-parks-1 file (got "${String(file.format)}")`);
    }
    this.#parks = file.parks.map((row) => {
      const [name, ...flat] = row;
      const poly: LngLat[] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) poly.push([flat[i]!, flat[i + 1]!]);
      return name === '' ? { poly } : { name, poly };
    });
    this.#boxes = this.#parks.map((p) => boxOf(p.poly));
    this.#loaded = true;
    this.#log(`kr-parks: ${this.#parks.length.toLocaleString()} polygons from ${this.options.file}`);
  }

  async load(region: Region): Promise<GeoBundle> {
    await this.prepare();
    const b = region.padded;
    const out = emptyBundle();
    for (let i = 0; i < this.#parks.length; i++) {
      const box = this.#boxes[i]!;
      if (box.east < b.west || box.west > b.east || box.north < b.south || box.south > b.north) continue;
      out.parks.push(this.#parks[i]!);
    }
    return out;
  }

  /**
   * Deliberately empty. The OSM source drops its cache between batches because
   * it holds a whole country's raw OSM; this one holds ~30 MB of rings and is
   * asked for them again on the very next batch.
   */
  release(): void {}
}
