/**
 * The two shapes features take on the way from a source to a tile: geographic
 * (`Geo*`, lng/lat, whole features) and tile-local (`Tile*`, integer units,
 * already clipped or anchored).
 *
 * @module
 */

import type { BuildingKind, PoiCategory, RoadClass } from '@maprama/protocol';
import type { Pt } from './geometry.js';
import type { LngLat } from './mercator.js';

/** Tile layer names, in the id order `design/tile-format.md` §4.1 fixes. */
export const LAYER_NAMES = ['roads', 'buildings', 'water', 'parks', 'pois', 'stations', 'districts'] as const;
/** One of the seven tile layers. */
export type LayerName = (typeof LAYER_NAMES)[number];

/** Layer ids as written into the payload. Fixed by the spec; never renumber. */
export const LAYER_ID: Record<LayerName, number> = {
  roads: 1,
  buildings: 2,
  water: 3,
  parks: 4,
  pois: 5,
  stations: 6,
  districts: 7,
};
/** Reverse of {@link LAYER_ID}. */
export const LAYER_BY_ID: Record<number, LayerName> = Object.fromEntries(
  LAYER_NAMES.map((name) => [LAYER_ID[name], name]),
) as Record<number, LayerName>;

/** Layers whose features are owned whole by the tile containing their anchor (§3.1). */
export const ANCHOR_LAYERS = ['buildings', 'pois', 'stations', 'districts'] as const satisfies readonly LayerName[];
/** Layers clipped to the tile plus the buffer (§3.2). */
export const CLIPPED_LAYERS = ['roads', 'water', 'parks'] as const satisfies readonly LayerName[];

/* ------------------------------------------------------------------- geo */

/** A road centreline in lng/lat. */
export interface GeoRoad {
  id: string;
  cls: RoadClass;
  name?: string;
  bridge?: boolean;
  pts: LngLat[];
}

/** A building footprint in lng/lat; height already in decimetres (§4.1). */
export interface GeoBuilding {
  id: string;
  heightDm: number;
  levels?: number;
  kind?: BuildingKind;
  name?: string;
  footprint: LngLat[];
}

/** A water polygon in lng/lat. */
export interface GeoWater {
  poly: LngLat[];
}

/** A park polygon in lng/lat. */
export interface GeoPark {
  name?: string;
  poly: LngLat[];
}

/** A POI in lng/lat. */
export interface GeoPoi {
  id: string;
  name: string;
  cat: PoiCategory;
  buildingId?: string;
  snapped?: boolean;
  snapDistanceMeters?: number;
  at: LngLat;
}

/** A station in lng/lat. */
export interface GeoStation {
  id: string;
  name: string;
  at: LngLat;
}

/** A district label anchor in lng/lat. */
export interface GeoDistrict {
  name: string;
  water?: boolean;
  at: LngLat;
}

/** One region's features, in lng/lat, per layer. */
export interface GeoBundle {
  roads: GeoRoad[];
  buildings: GeoBuilding[];
  water: GeoWater[];
  parks: GeoPark[];
  pois: GeoPoi[];
  stations: GeoStation[];
  districts: GeoDistrict[];
}

/** An empty bundle. */
export function emptyBundle(): GeoBundle {
  return { roads: [], buildings: [], water: [], parks: [], pois: [], stations: [], districts: [] };
}

/* ------------------------------------------------------------------ tile */

/** A road inside one tile. `id` carries a `#n` suffix when the clip split it. */
export interface TileRoad {
  id: string;
  cls: RoadClass;
  name?: string;
  bridge?: boolean;
  pts: Pt[];
}

/** A building inside one tile; geometry is whole and may exceed the tile edge. */
export interface TileBuilding {
  id: string;
  heightDm: number;
  levels?: number;
  kind?: BuildingKind;
  name?: string;
  footprint: Pt[];
}

/** A clipped water polygon. */
export interface TileWater {
  poly: Pt[];
}

/** A clipped park polygon. */
export interface TilePark {
  name?: string;
  poly: Pt[];
}

/** A POI inside one tile. */
export interface TilePoi {
  id: string;
  name: string;
  cat: PoiCategory;
  buildingId?: string;
  snapped?: boolean;
  snapDistanceMeters?: number;
  u: number;
  v: number;
}

/** A station inside one tile. */
export interface TileStation {
  id: string;
  name: string;
  u: number;
  v: number;
}

/** A district label inside one tile. */
export interface TileDistrict {
  name: string;
  water?: boolean;
  u: number;
  v: number;
}

/** The seven layers of one tile. */
export interface TileLayers {
  roads: TileRoad[];
  buildings: TileBuilding[];
  water: TileWater[];
  parks: TilePark[];
  pois: TilePoi[];
  stations: TileStation[];
  districts: TileDistrict[];
}

/** An empty layer set. */
export function emptyLayers(): TileLayers {
  return { roads: [], buildings: [], water: [], parks: [], pois: [], stations: [], districts: [] };
}
