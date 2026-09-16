/**
 * Geographic coordinates and the local world-unit projection shared by every
 * engine.
 *
 * World space is a local tangent plane around an origin: `+x` = east,
 * `-z` = north (north is negative z), `y` = up. One world unit is
 * `unitMeters` meters (8 m by default).
 *
 * @module
 */

import { number, object, range, type Check } from './internal/validate.js';

/** A WGS84 coordinate in degrees. Used for every coordinate in the public API. */
export interface LngLat {
  /** Longitude in degrees, [-180, 180]. */
  lng: number;
  /** Latitude in degrees, [-90, 90]. */
  lat: number;
}

/** A point on the engine's ground plane, in world units (+x east, -z north). */
export interface WorldPoint {
  x: number;
  z: number;
}

/**
 * An axis-aligned geographic box, given by its north-east and south-west
 * corners. Used by `fitBounds`. A box that crosses the antimeridian (`ne.lng <
 * sw.lng`) is not supported; split it into two boxes.
 */
export interface LngLatBounds {
  /** North-east corner (the larger `lat`, and the larger `lng`). */
  ne: LngLat;
  /** South-west corner (the smaller `lat`, and the smaller `lng`). */
  sw: LngLat;
}

/** Default size of one world unit in meters. */
export const DEFAULT_UNIT_METERS = 8;

/** Meters per degree of longitude at the equator used by the projection. */
export const METERS_PER_DEGREE_LNG = 111320;

/** Meters per degree of latitude used by the projection. */
export const METERS_PER_DEGREE_LAT = 110540;

/** Mean Earth radius in meters used by {@link haversineMeters}. */
export const EARTH_RADIUS_METERS = 6371008.8;

/** Options for {@link createProjection}. */
export interface ProjectionOptions {
  /** Geographic coordinate that maps to world `{ x: 0, z: 0 }`. */
  origin: LngLat;
  /** Meters per world unit. Defaults to {@link DEFAULT_UNIT_METERS}. Must be > 0. */
  unitMeters?: number;
}

/** Converts between geographic coordinates, world units and meters. */
export interface Projection {
  /** The origin this projection was created with. */
  readonly origin: Readonly<LngLat>;
  /** Meters per world unit. */
  readonly unitMeters: number;
  /** Projects a geographic coordinate to world units. */
  toWorld(lngLat: LngLat): WorldPoint;
  /** Inverse of {@link Projection.toWorld}. */
  toLngLat(point: WorldPoint): LngLat;
  /** Converts a distance in meters to world units. */
  metersToUnits(meters: number): number;
  /** Converts a distance in world units to meters. */
  unitsToMeters(units: number): number;
}

/**
 * Creates an equirectangular local-tangent-plane projection around `origin`:
 * `x = Δlng · cos(lat0) · 111320 / unitMeters`, `z = −Δlat · 110540 / unitMeters`.
 *
 * Accurate for city-scale worlds (a few kilometres); the inverse is exact.
 *
 * @throws RangeError if `origin` is not a valid coordinate or `unitMeters` is not a positive finite number.
 */
export function createProjection(options: ProjectionOptions): Projection {
  const { origin } = options;
  const unitMeters = options.unitMeters ?? DEFAULT_UNIT_METERS;
  const originError = checkLngLat(origin, 'origin');
  if (originError) throw new RangeError(`createProjection: ${originError}`);
  if (!(typeof unitMeters === 'number' && Number.isFinite(unitMeters) && unitMeters > 0)) {
    throw new RangeError(`createProjection: unitMeters must be a positive finite number, got ${unitMeters}`);
  }
  const lng0 = origin.lng;
  const lat0 = origin.lat;
  const cosLat0 = Math.cos((lat0 * Math.PI) / 180);
  // Guard the poles so the inverse never divides by zero.
  const metersPerDegLng = METERS_PER_DEGREE_LNG * Math.max(cosLat0, 1e-12);

  return {
    origin: Object.freeze({ lng: lng0, lat: lat0 }),
    unitMeters,
    toWorld(lngLat) {
      return {
        x: ((lngLat.lng - lng0) * metersPerDegLng) / unitMeters,
        z: (-(lngLat.lat - lat0) * METERS_PER_DEGREE_LAT) / unitMeters,
      };
    },
    toLngLat(point) {
      return {
        lng: lng0 + (point.x * unitMeters) / metersPerDegLng,
        lat: lat0 - (point.z * unitMeters) / METERS_PER_DEGREE_LAT,
      };
    },
    metersToUnits(meters) {
      return meters / unitMeters;
    },
    unitsToMeters(units) {
      return units * unitMeters;
    },
  };
}

/** Great-circle distance in meters between two coordinates (haversine formula). */
export function haversineMeters(a: LngLat, b: LngLat): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** @internal Runtime check for {@link LngLat}. */
export const checkLngLat: Check = object({ lng: range(-180, 180), lat: range(-90, 90) });

/** @internal Runtime check for {@link WorldPoint}. */
export const checkWorldPoint: Check = object({ x: number, z: number });

/** @internal Runtime check for {@link LngLatBounds} (corners valid; `ne` north-east of `sw`). */
export const checkLngLatBounds: Check = (v, p) => {
  const err = object({ ne: checkLngLat, sw: checkLngLat })(v, p);
  if (err) return err;
  const b = v as LngLatBounds;
  if (b.ne.lat < b.sw.lat) return `${p}: ne.lat must be >= sw.lat`;
  if (b.ne.lng < b.sw.lng) return `${p}: ne.lng must be >= sw.lng (a box across the antimeridian is not supported)`;
  return null;
};
