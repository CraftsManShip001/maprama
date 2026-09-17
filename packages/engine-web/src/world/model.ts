/**
 * The engine's internal, source-independent world model. Procedural layouts
 * (`grid`, `town`) and real `WorldData` are all converted into this shape so a
 * single set of renderers handles every source.
 *
 * Coordinates are world units: +x east, +z south, y up.
 *
 * @module
 */

import type { BuildingKind, District, LngLat, Poi, Projection, Station, Vec2, WorldBounds } from '@maprama/protocol';
import type { RoadGraph } from './graph.js';

/** Massing variants for rectangular lots (prototype `massesFor`). */
export type MassShape = 'box' | 'podium' | 'setback' | 'L' | 'twin';

/** Roof kinds. */
export type RoofKind = 'flat' | 'gable' | 'dome';

/** One building, rectangular lot or arbitrary footprint. */
export interface BuildingModel {
  /** Stable id (used by `building:press` / `setBuildingStyle`). */
  id: string;
  /** Sequential index (seeds per-building randomness). */
  idx: number;
  name?: string;
  /** Anchor: rectangle center or polygon centroid. */
  x: number;
  z: number;
  /** Rotation around y (`Object3D.rotation.y`) of the rectangle; 0 for polygons. */
  yaw: number;
  /**
   * Oriented rectangle size when the footprint is a rectangle (procedural lots
   * and near-rectangular real footprints). Enables the full massing/roof
   * language. `null` for arbitrary polygons.
   */
  rect: { w: number; d: number } | null;
  /** Footprint ring in world units (positive shoelace area, see `normalizeRing`). */
  footprint: Vec2[];
  /** Height in world units before the theme's height scale. */
  h: number;
  levels?: number;
  kind: BuildingKind;
  roof: RoofKind;
  /** Palette index. */
  ci: number;
  decos: { sign: boolean; antenna: boolean; garden: boolean };
  /** Massing used when the theme's massing is `varied`. */
  autoShape: MassShape;
  /**
   * The central landmark tower: a stylised spire drawn instead of the normal
   * massing, with a spinning star on top. Only the procedural `town` and
   * `grid` worlds set this — `WorldData` worlds render exactly the buildings
   * the document lists, so a data world has no landmark.
   */
  landmark: boolean;
}

/** A ground ribbon (polyline with width), e.g. a river or a river bank. */
export interface Ribbon {
  pts: Vec2[];
  width: number;
}

/** Raised block pad of the procedural grid. */
export interface GridBlock {
  cx: number;
  cz: number;
  kind: 'city' | 'plaza' | 'park';
  bi: number;
  bj: number;
}

export interface SceneryTree {
  x: number;
  z: number;
  y: number;
  s: number;
  /** Draw without toon outline. */
  noOutline?: boolean;
}

/**
 * Where a world came from. `tiles` is a streamed PMTiles archive
 * (`WorldSource { kind: 'tiles' }`): the model is re-assembled from whichever
 * tiles are loaded, around a render anchor that follows the camera.
 */
export type WorldKind = 'grid' | 'town' | 'data' | 'tiles';

/** Source-independent world. */
export interface WorldModel {
  kind: WorldKind;
  name: string;
  /** Geographic coordinate of world (0, 0). */
  origin: LngLat;
  unitMeters: number;
  /**
   * The world's own coordinate conversion, when the equirectangular tangent
   * plane of `origin` + `unitMeters` is not it.
   *
   * Only a tile world sets this. Its frame is Web Mercator (see
   * `tiles/mercator.ts`): the tangent plane would place tiles kilometres apart
   * from each other across a country, which is a seam you can see. `origin` and
   * `unitMeters` stay meaningful — they are the render anchor and the ground
   * metres per unit *there* — so anything that only reads them keeps working.
   */
  projection?: Projection;
  bounds: WorldBounds;
  graph: RoadGraph;
  buildings: BuildingModel[];
  /** Water polygons. */
  water: Vec2[][];
  /**
   * Polylines to draw the water rim (bank) along, when it is **not** simply the
   * closed ring of every `water` polygon.
   *
   * Only a tile world sets this. A river clipped at a tile edge gets a straight
   * cut that is not a bank, and drawing a rim along it puts a green stripe down
   * the middle of the river (`design/tile-format.md` §3.2). The assembler drops
   * those edges and passes what is left. `null` means "use the closed rings",
   * which is what every other world does.
   */
  waterRims: Vec2[][] | null;
  /** Water drawn as wide ribbons (procedural river). */
  waterRibbons: Ribbon[];
  /** Park-colored banks along water. */
  banks: Ribbon[];
  /** Paved landuse polygons drawn over the ground. */
  pads: Vec2[][];
  parks: { name?: string; poly: Vec2[] }[];
  plaza: { x: number; z: number; radius: number } | null;
  /** Raised block pads (procedural grid only). */
  gridBlocks: GridBlock[] | null;
  sceneryTrees: SceneryTree[];
  /** Ground treatment: textured grass (grid), lawn color (town) or paved (real data). */
  ground: 'grass' | 'lawn' | 'paved';
  /** Y of building bases. */
  buildingBaseY: number;
  pois: Poi[];
  stations: Station[];
  districts: District[];
  /** Default camera / player start. */
  start: { x: number; z: number };
  /** Suggested item spawn points (part 2). */
  spawn: Vec2[];
  /** Suggested NPC loop (part 2). */
  loopWays: Vec2[];
  attribution: string[];
}

/** Default geographic origin for procedural layouts (Seoul City Hall). */
export const PROCEDURAL_ORIGIN: Readonly<LngLat> = Object.freeze({ lng: 126.978, lat: 37.5665 });
