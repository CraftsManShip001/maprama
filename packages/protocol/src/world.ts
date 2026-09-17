/**
 * `WorldData` v1: the vector map data an engine renders (roads, building
 * footprints, water, parks, POIs, stations, districts), plus the ways a host
 * can supply a world.
 *
 * All geometry is in world units on the local tangent plane defined by
 * `origin` and `unitMeters` (see {@link createProjection}): +x east, -z north.
 *
 * @module
 */

import { checkLngLat, checkWorldPoint, type LngLat, type WorldPoint } from './geo.js';
import {
  array,
  boolean,
  discriminated,
  integer,
  literal,
  nonEmptyString,
  nonNegativeNumber,
  number,
  object,
  oneOf,
  positiveNumber,
  range,
  run,
  string,
  tuple,
  type Check,
  type ValidationResult,
} from './internal/validate.js';

/** Current `WorldData` schema version. */
export const WORLD_DATA_VERSION = 1;

/** A 2D position `[x, z]` in world units. */
export type Vec2 = [number, number];

/** A simple polygon ring of `[x, z]` world-unit vertices (not closed). */
export type Polygon = Vec2[];

/** Road classes, widest to narrowest. */
export const ROAD_CLASSES = ['arterial', 'local', 'alley'] as const;
/** Road class: `arterial` (main road), `local` (street) or `alley`. */
export type RoadClass = (typeof ROAD_CLASSES)[number];

/** A road centreline. */
export interface Road {
  /** Stable id, unique within the world. */
  id: string;
  /** Street name, if known. */
  name?: string;
  /** Road class (controls width and markings). */
  cls: RoadClass;
  /** True when the road is a bridge (rendered elevated over water). */
  bridge?: boolean;
  /** Polyline vertices `[x, z]` in world units (at least 2). */
  pts: Vec2[];
}

/** Facade material families used by the realistic/modern/urban facade sets. */
export const BUILDING_KINDS = ['glass', 'office', 'apartment', 'brick'] as const;
/** Building facade kind. */
export type BuildingKind = (typeof BUILDING_KINDS)[number];

/** An extruded building footprint. */
export interface BuildingFootprint {
  /** Stable id, unique within the world (used by `building:press` and `setBuildingStyle`). */
  id: string;
  /** Footprint ring `[x, z]` in world units: positive shoelace area over the stored `[x, z]` values ("counter-clockwise" in x/z; appears clockwise on a north-up map because z = -north), not closed, at least 3 vertices. */
  footprint: Vec2[];
  /** Height in world units (before the theme's `heightScale`). */
  height: number;
  /** Number of above-ground floors, if known. */
  levels?: number;
  /** Facade kind hint. */
  kind?: BuildingKind;
  /** Building name, if known. */
  name?: string;
}

/** A park or green area. */
export interface Park {
  name?: string;
  poly: Polygon;
}

/** Point-of-interest categories (also used as label icons). */
export const POI_CATEGORIES = ['subway', 'cafe', 'store', 'music', 'school', 'book', 'plaza', 'park'] as const;
/** Point-of-interest category. */
export type PoiCategory = (typeof POI_CATEGORIES)[number];

/** A point of interest. */
export interface Poi {
  id: string;
  name: string;
  cat: PoiCategory;
  /** Position in world units. */
  x: number;
  /** Position in world units. */
  z: number;
  /**
   * Id of the {@link BuildingFootprint} this POI belongs to, when the world
   * build could attach one — either because a footprint contains `x`/`z`, or
   * because the POI was snapped onto the nearest footprint within range.
   *
   * Optional: worlds built before this field existed simply do not have it, and
   * a POI in open space (a park, a plaza, a genuinely unmapped building) never
   * gets one. An engine uses it to anchor a pin or a label on the roof instead
   * of the ground.
   */
  buildingId?: string;
  /**
   * True when `x`/`z` were moved onto `buildingId` because no footprint
   * contained the original position. Absent means the POI was already inside
   * the footprint (or has no `buildingId` at all).
   */
  snapped?: boolean;
  /** How far `x`/`z` moved in meters. Only present together with `snapped`. */
  snapDistanceMeters?: number;
}

/** A transit (subway) station, used by `subway` travel. */
export interface Station {
  id: string;
  name: string;
  x: number;
  z: number;
}

/** A named district label anchor. */
export interface District {
  name: string;
  x: number;
  z: number;
  /** True when the name denotes a body of water (e.g. a river). */
  water?: boolean;
}

/** Axis-aligned world bounds in world units. */
export interface WorldBounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** Vector map data for one world, schema version 1. */
export interface WorldData {
  version: 1;
  /** Human-readable world name. */
  name: string;
  /** Geographic coordinate of world `{ x: 0, z: 0 }`. */
  origin: LngLat;
  /** Meters per world unit (normally 8). */
  unitMeters: number;
  bounds: WorldBounds;
  roads: Road[];
  buildings: BuildingFootprint[];
  water: Polygon[];
  parks: Park[];
  pois: Poi[];
  stations: Station[];
  districts: District[];
  /** Central plaza position, if the world has one (spawn / landmark anchor). */
  plaza?: WorldPoint;
  /** Attribution lines that must be displayed, e.g. `"© OpenStreetMap contributors"`. */
  attribution: string[];
}

/** Procedural demo layouts built into engines. */
export const PROCEDURAL_LAYOUTS = ['grid', 'town'] as const;
/** Procedural demo layout name. */
export type ProceduralLayout = (typeof PROCEDURAL_LAYOUTS)[number];

/**
 * A streamed tile world: one PMTiles archive the engine reads pieces of with
 * HTTP range requests, instead of one document it loads whole.
 *
 * The format is `design/tile-format.md` (MTIL v1); `@maprama/protocol`'s
 * {@link decodeTile} is the reader. A tile world can be the size of a country,
 * so the engine keeps a *render anchor* and re-bases world coordinates around
 * it as the camera travels — see the engine guide for what that changes about
 * world-unit coordinates in the public API.
 */
export interface TileWorldSource {
  kind: 'tiles';
  /** URL of the PMTiles archive. The server must answer HTTP range requests. */
  url: string;
  /**
   * Where the map opens. Unlike `kind: 'data'` / `kind: 'url'`, the data does
   * not carry an origin or a plaza, so the host has to say where to start.
   */
  center: LngLat;
  /** Forces the detail zoom level. Defaults to the archive's `maxZoom`. */
  detailZoom?: number;
  /** Forces the overview zoom level. Defaults to the archive's `minZoom`. */
  overviewZoom?: number;
  /** Upper bound on tiles kept in memory at once. The engine picks a default. */
  tileBudget?: number;
}

/** Where an engine gets its world from. */
export type WorldSource =
  /** Inline world data. */
  | { kind: 'data'; world: WorldData }
  /** URL of a `WorldData` JSON document the engine fetches. */
  | { kind: 'url'; url: string }
  /** A generated demo layout, deterministic for a given seed. */
  | { kind: 'procedural'; layout: ProceduralLayout; seed?: number }
  /** A streamed PMTiles archive of MTIL tiles. */
  | TileWorldSource;

const vec2: Check = tuple(number, number);

/** A slippy-map zoom level: an integer in `[0, 24]`. */
const zoomLevel: Check = (v, p) =>
  Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 24 ? null : `${p}: expected an integer zoom level in [0, 24]`;

/** A positive integer count (tile budget). */
const positiveInteger: Check = (v, p) =>
  Number.isSafeInteger(v) && (v as number) > 0 ? null : `${p}: expected a positive integer`;

/** @internal */
export const checkWorldData: Check = object(
  {
    version: literal(WORLD_DATA_VERSION),
    name: string,
    origin: checkLngLat,
    unitMeters: positiveNumber,
    bounds: object({ minX: number, minZ: number, maxX: number, maxZ: number }),
    roads: array(
      object(
        { id: nonEmptyString, cls: oneOf(ROAD_CLASSES), pts: array(vec2, { min: 2 }) },
        { name: string, bridge: boolean },
      ),
    ),
    buildings: array(
      object(
        { id: nonEmptyString, footprint: array(vec2, { min: 3 }), height: nonNegativeNumber },
        { levels: range(0, Number.MAX_SAFE_INTEGER), kind: oneOf(BUILDING_KINDS), name: string },
      ),
    ),
    water: array(array(vec2, { min: 3 })),
    parks: array(object({ poly: array(vec2, { min: 3 }) }, { name: string })),
    pois: array(
      object(
        { id: nonEmptyString, name: string, cat: oneOf(POI_CATEGORIES), x: number, z: number },
        { buildingId: nonEmptyString, snapped: boolean, snapDistanceMeters: nonNegativeNumber },
      ),
    ),
    stations: array(object({ id: nonEmptyString, name: string, x: number, z: number })),
    districts: array(object({ name: string, x: number, z: number }, { water: boolean })),
    attribution: array(string),
  },
  { plaza: checkWorldPoint },
);

/** @internal */
export const checkWorldSource: Check = discriminated('kind', {
  data: object({ world: checkWorldData }),
  url: object({ url: nonEmptyString }),
  procedural: object({ layout: oneOf(PROCEDURAL_LAYOUTS) }, { seed: integer }),
  tiles: object(
    { url: nonEmptyString, center: checkLngLat },
    { detailZoom: zoomLevel, overviewZoom: zoomLevel, tileBudget: positiveInteger },
  ),
});

/**
 * Validates an unknown value (e.g. parsed JSON) against the `WorldData` v1
 * schema. Checks structure and types only; it does not verify polygon winding
 * or that geometry lies within `bounds`. Never throws.
 */
export function validateWorldData(value: unknown): ValidationResult {
  return run(checkWorldData, value);
}

/** Validates an unknown value as a {@link WorldSource}. Never throws. */
export function validateWorldSource(value: unknown): ValidationResult {
  return run(checkWorldSource, value);
}
