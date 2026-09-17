/**
 * Web-Mercator slippy-tile maths, and the world frame a streamed tile world
 * renders in.
 *
 * ## Why a tile world does not use `createProjection`
 *
 * `@maprama/protocol`'s {@link createProjection} is an **equirectangular local
 * tangent plane**: `x = Δlng · cos(lat₀) · 111320 / unitMeters`. It uses the
 * cosine of the *origin* latitude everywhere, which is exact at the origin and
 * wrong in proportion to how far north or south you go. Over a city (a few km)
 * the error is millimetres. Over South Korea it is not:
 *
 * ```
 * error ≈ x · tan(lat₀) · Δlat_rad    (x = east offset, Δlat = north offset)
 *       ≈ 1.2e-7 · D²  metres at lat 37.5 for D = |x| = |z|
 * ```
 *
 * which is 0.5 m at 2 km, 12 m at 10 km and 48 m at 20 km. Two neighbouring
 * tiles placed with that projection do **not** meet: a road would step sideways
 * at every tile edge. That is a seam you can see, and no amount of float
 * precision fixes it.
 *
 * ## The frame a tile world uses instead
 *
 * Web Mercator, scaled so that one world unit is `unitMeters` metres of ground
 * **at the world's reference latitude** `refLat`:
 *
 * ```
 * x = (mx − anchor.mx) · C · cos(refLat) / unitMeters
 * z = (my − anchor.my) · C · cos(refLat) / unitMeters       (C = equatorial circumference)
 * ```
 *
 * Three things fall out of it, and they are the reasons for the choice:
 *
 * 1. **Tiles line up.** The map from tile-local integers to world units is
 *    linear in mercator space, so tile `x` ends where tile `x+1` begins up to
 *    float64 rounding — a gap of order 1e-14 world units, which is *below what
 *    a `Float32Array` vertex buffer can even represent*: both edges round to
 *    the same float32. A seam is impossible by construction rather than by luck.
 * 2. **Re-basing is a pure translation.** Moving the anchor only changes
 *    `anchor.mx` / `anchor.my`; `refLat` (and therefore the scale) never moves.
 *    A translation applied to the camera and to every object in the same frame
 *    is, by definition, invisible.
 * 3. **The scale is honest near the camera and drifts like a Mercator map
 *    elsewhere** — exactly the behaviour of every other web map. One world unit
 *    is `unitMeters · cos(lat) / cos(refLat)` metres of real ground;
 *    {@link metresPerUnitAt} is that factor, and the engine reports distances
 *    with the value at the current anchor rather than pretending it is constant.
 *    Across South Korea (lat 33 – 38.6) the spread is 3.1 %.
 *
 * @module
 */

import type { LngLat } from '@maprama/protocol';

/** Web Mercator equatorial circumference, metres. */
export const EARTH_CIRCUMFERENCE = 40075016.685578488;

const DEG = Math.PI / 180;

/** A normalised Web Mercator position, both axes in `[0, 1)`; `my` grows south. */
export interface MercatorPoint {
  mx: number;
  my: number;
}

/** A slippy tile address. */
export interface TileId {
  z: number;
  x: number;
  y: number;
}

/** `"z/x/y"`, the key tiles are cached and compared by. */
export const tileKey = (z: number, x: number, y: number): string => `${z}/${x}/${y}`;

/** Longitude/latitude → normalised Web Mercator. */
export function lngLatToMercator(lng: number, lat: number): MercatorPoint {
  const clamped = Math.max(-85.051129, Math.min(85.051129, lat));
  const s = Math.sin(clamped * DEG);
  return { mx: (lng + 180) / 360, my: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI) };
}

/** Normalised Web Mercator → longitude/latitude. */
export function mercatorToLngLat(mx: number, my: number): LngLat {
  return { lng: mx * 360 - 180, lat: (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI };
}

/** The tile a coordinate falls in. Stateless and deterministic — this is the whole "which tile?" rule. */
export function tileOf(lng: number, lat: number, z: number): TileId {
  const { mx, my } = lngLatToMercator(lng, lat);
  const n = 2 ** z;
  return { z, x: clampTile(Math.floor(mx * n), n), y: clampTile(Math.floor(my * n), n) };
}

const clampTile = (v: number, n: number): number => (v < 0 ? 0 : v > n - 1 ? n - 1 : v);

/** Geographic bounds of a tile. */
export function tileBounds(z: number, x: number, y: number): { west: number; south: number; east: number; north: number } {
  const n = 2 ** z;
  const nw = mercatorToLngLat(x / n, y / n);
  const se = mercatorToLngLat((x + 1) / n, (y + 1) / n);
  return { west: nw.lng, north: nw.lat, east: se.lng, south: se.lat };
}

/** Ground size of a tile edge at `lat`, in metres. */
export function tileGroundMeters(z: number, lat: number): number {
  return (EARTH_CIRCUMFERENCE * Math.cos(lat * DEG)) / 2 ** z;
}

/**
 * Real ground metres one world unit covers at `lat`, for a frame whose
 * reference latitude is `refLat`. Exactly `unitMeters` at `refLat`.
 */
export function metresPerUnitAt(unitMeters: number, refLat: number, lat: number): number {
  const ref = Math.max(Math.cos(refLat * DEG), 1e-9);
  return (unitMeters * Math.cos(lat * DEG)) / ref;
}

/**
 * The world frame of a tile world: Web Mercator anchored at a point and scaled
 * to metres at `refLat` (see the module docs).
 *
 * `anchor` is the **render anchor**: the geographic position of world
 * `{ x: 0, z: 0 }`. It is the only thing a re-base changes.
 */
export class TileFrame {
  /** Mercator position of world `(0, 0)`. */
  anchorMx: number;
  anchorMy: number;
  /** World units per mercator unit (positive; same for both axes). */
  readonly unitsPerMercator: number;

  constructor(
    anchor: LngLat,
    /** Latitude the frame's scale is true at; the scale never changes afterwards. */
    readonly refLat: number,
    /** Metres of ground one world unit covers **at `refLat`**. */
    readonly unitMeters: number,
  ) {
    const m = lngLatToMercator(anchor.lng, anchor.lat);
    this.anchorMx = m.mx;
    this.anchorMy = m.my;
    this.unitsPerMercator = (EARTH_CIRCUMFERENCE * Math.cos(refLat * DEG)) / unitMeters;
  }

  /** The current anchor as a coordinate. */
  get anchor(): LngLat {
    return mercatorToLngLat(this.anchorMx, this.anchorMy);
  }

  /**
   * Moves the anchor to `next` and returns the world-unit delta every existing
   * world coordinate has to be shifted by to stay in the same place on the
   * ground: `newCoord = oldCoord + delta`.
   *
   * This is a pure translation — the scale is fixed at construction — which is
   * what makes a re-base invisible: apply the same delta to the camera, the
   * geometry, the characters and the overlays and the frame renders identically.
   */
  rebase(next: LngLat): { dx: number; dz: number } {
    const m = lngLatToMercator(next.lng, next.lat);
    const dx = (this.anchorMx - m.mx) * this.unitsPerMercator;
    const dz = (this.anchorMy - m.my) * this.unitsPerMercator;
    this.anchorMx = m.mx;
    this.anchorMy = m.my;
    return { dx, dz };
  }

  /** Coordinate → world units. */
  toWorld(lngLat: LngLat): { x: number; z: number } {
    const m = lngLatToMercator(lngLat.lng, lngLat.lat);
    return { x: (m.mx - this.anchorMx) * this.unitsPerMercator, z: (m.my - this.anchorMy) * this.unitsPerMercator };
  }

  /** World units → coordinate. */
  toLngLat(point: { x: number; z: number }): LngLat {
    return mercatorToLngLat(this.anchorMx + point.x / this.unitsPerMercator, this.anchorMy + point.z / this.unitsPerMercator);
  }

  /**
   * World-unit position of a tile's `(0, 0)` corner (its north-west corner) and
   * the world units one tile-local unit covers. Linear in the tile address, so
   * neighbours meet exactly.
   */
  tilePlacement(z: number, x: number, y: number, extent: number): { originX: number; originZ: number; scale: number } {
    const n = 2 ** z;
    return {
      originX: (x / n - this.anchorMx) * this.unitsPerMercator,
      originZ: (y / n - this.anchorMy) * this.unitsPerMercator,
      scale: this.unitsPerMercator / (n * extent),
    };
  }

  /** Real ground metres one world unit covers at the current anchor. */
  get anchorUnitMeters(): number {
    return metresPerUnitAt(this.unitMeters, this.refLat, this.anchor.lat);
  }
}
