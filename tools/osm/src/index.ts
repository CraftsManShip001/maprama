/**
 * `@maprama/osm`: OpenStreetMap (Overpass) → Maprama `WorldData` builder.
 *
 * @packageDocumentation
 */

export { KR_ATTRIBUTION, OSM_ATTRIBUTION, assertBBox, buildWorld, buildWorldWithStats, inferBBox, stringifyWorld } from './build.js';
export type { BuildStats, BuildWorldOptions, BuildWorldResult } from './build.js';
export {
  METERS_PER_LEVEL,
  classifyKind,
  classifyPoi,
  classifyRoad,
  displayName,
  heuristicHeightMeters,
  isBridge,
  parseLevels,
  parseMeters,
  resolveHeight,
} from './classify.js';
export type { ExternalHeight, ResolvedHeight, RoadClassifyOptions } from './classify.js';
export {
  clipPolylineToRect,
  clipRingToRect,
  ensureCCW,
  interiorPoint,
  pointInRing,
  ringArea,
  ringCentroid,
  signedArea,
  simplifyLine,
  simplifyRing,
} from './geometry.js';
export type { Rect } from './geometry.js';
export { KR_MIN_OVERLAP, KrBuildingIndex, intersectionArea } from './kr.js';
export type { KrMatch } from './kr.js';
export {
  DEFAULT_OVERPASS_ENDPOINTS,
  DEFAULT_USER_AGENT,
  buildOverpassQuery,
  cacheFileFor,
  fetchOverpass,
  parseBBox,
} from './overpass.js';
export type { FetchOverpassOptions } from './overpass.js';
export { SAMPLES } from './samples.js';
export type { SampleArea } from './samples.js';
export type {
  BBox,
  OverpassElement,
  OverpassLatLon,
  OverpassNode,
  OverpassRelation,
  OverpassRelationMember,
  OverpassResponse,
  OverpassWay,
  RawMeta,
  Tags,
} from './types.js';
