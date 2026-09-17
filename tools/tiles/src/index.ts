/**
 * `@maprama/tiles`: builds an MTIL v1 / PMTiles archive for a whole country from
 * an OSM extract, and reads one back.
 *
 * @packageDocumentation
 */

export {
  DEFAULT_BUFFER,
  DEFAULT_EXTENT,
  DEFAULT_PROFILES,
  batchChunks,
  buildArchive,
  clearWork,
  planChunks,
  windowFor,
} from './build.js';
export type { BuildArchiveOptions, BuildReport, Profile } from './build.js';
export { DEFAULT_PAD_DEG, padBounds } from './chunks.js';
export type { Chunk, PlanChunksOptions } from './chunks.js';
export {
  clipPolygon,
  clipPolyline,
  clipRect,
  dedupe,
  isSyntheticEdge,
  ringAnchor,
  ringAreaM2,
  syntheticEdgeCount,
} from './geometry.js';
export type { ClipRect, Pt } from './geometry.js';
export {
  EARTH_CIRCUMFERENCE,
  METERS_PER_DEGREE_LAT,
  METERS_PER_DEGREE_LNG,
  boundsOf,
  fromTileLocal,
  lngLatToMercator,
  mercatorToLngLat,
  tileBounds,
  tileGroundMeters,
  tileOf,
  tileRange,
  tileUnitMeters,
  toGlobalLocal,
  toTileLocal,
  worldToLngLat,
} from './mercator.js';
export type { GeoBounds, LngLat, TileXYZ } from './mercator.js';
export { FLAG_CLIPPED, MAGIC, MTIL_VERSION, decodeTile, encodeTile } from './mtil.js';
export type { DecodedTile, EncodeTileOptions } from './mtil.js';
export { OsmPbfSource, worldToGeo } from './osm-source.js';
export type { OsmPbfSourceOptions } from './osm-source.js';
export {
  ArchiveWriter,
  Compression,
  HEADER_BYTES,
  ROOT_BUDGET_BYTES,
  TileType,
  buildDirectories,
  serializeDirectory,
  zxyToTileId,
} from './pmtiles.js';
export type { ArchiveStats, Directories, Entry, FinishOptions } from './pmtiles.js';
export { FileSource, openArchive, readTile } from './reader.js';
export {
  DEFAULT_LAYER_ROUTING,
  activeSources,
  attributionIndices,
  attributionTable,
  composeRegion,
  tileAttribution,
  validateRouting,
} from './sources.js';
export type { LayerRouting, Region, TileSource } from './sources.js';
export { filterForOverview, tileBundle } from './tiler.js';
export type { BuiltTile, OverviewOptions, TileBundleOptions, TileBundleResult, TileStats, TileWindow } from './tiler.js';
export {
  ANCHOR_LAYERS,
  CLIPPED_LAYERS,
  LAYER_BY_ID,
  LAYER_ID,
  LAYER_NAMES,
  emptyBundle,
  emptyLayers,
} from './types.js';
export type {
  GeoBuilding,
  GeoBundle,
  GeoDistrict,
  GeoPark,
  GeoPoi,
  GeoRoad,
  GeoStation,
  GeoWater,
  LayerName,
  TileBuilding,
  TileDistrict,
  TileLayers,
  TilePark,
  TilePoi,
  TileRoad,
  TileStation,
  TileWater,
} from './types.js';
