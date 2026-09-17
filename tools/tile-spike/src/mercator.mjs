/** Web-Mercator slippy-tile maths (EPSG:3857 / XYZ), plus the inverse of the
 *  equirectangular local-tangent-plane projection `@maprama/protocol` uses.
 *
 *  Kept dependency-free so the spike can be re-run from a bare checkout.
 */

export const METERS_PER_DEGREE_LNG = 111320;
export const METERS_PER_DEGREE_LAT = 110540;
/** Web Mercator equatorial circumference, metres. */
export const EARTH_CIRCUMFERENCE = 40075016.685578488;

/** WorldData local units -> lng/lat. Exact inverse of `createProjection().toWorld`. */
export function worldToLngLat(origin, unitMeters, x, z) {
  const cosLat0 = Math.max(Math.cos((origin.lat * Math.PI) / 180), 1e-12);
  return {
    lng: origin.lng + (x * unitMeters) / (METERS_PER_DEGREE_LNG * cosLat0),
    lat: origin.lat - (z * unitMeters) / METERS_PER_DEGREE_LAT,
  };
}

/** lng/lat -> normalised Web Mercator, both in [0, 1); y grows south. */
export function lngLatToMercator(lng, lat) {
  const s = Math.sin((lat * Math.PI) / 180);
  return {
    mx: (lng + 180) / 360,
    my: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI),
  };
}

/** Normalised Web Mercator -> lng/lat. */
export function mercatorToLngLat(mx, my) {
  return {
    lng: mx * 360 - 180,
    lat: (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI,
  };
}

/**
 * The tile a coordinate belongs to. Deterministic and stateless: this is the
 * whole "which tile do I need?" rule.
 */
export function tileOf(lng, lat, z) {
  const { mx, my } = lngLatToMercator(lng, lat);
  const n = 2 ** z;
  return { z, x: Math.min(n - 1, Math.floor(mx * n)), y: Math.min(n - 1, Math.floor(my * n)) };
}

/** Geographic bounds of tile z/x/y, as `{ west, south, east, north }`. */
export function tileBounds(z, x, y) {
  const n = 2 ** z;
  const nw = mercatorToLngLat(x / n, y / n);
  const se = mercatorToLngLat((x + 1) / n, (y + 1) / n);
  return { west: nw.lng, north: nw.lat, east: se.lng, south: se.lat };
}

/** Ground size of a tile at `lat`, in metres (mercator scale factor = 1/cos φ). */
export function tileGroundMeters(z, lat) {
  return (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}

/** Ground area of tile z/x/y in km², integrating the latitude-dependent scale. */
export function tileGroundAreaKm2(z, x, y) {
  const b = tileBounds(z, x, y);
  const midLat = (b.north + b.south) / 2;
  const w = ((b.east - b.west) * METERS_PER_DEGREE_LNG * Math.cos((midLat * Math.PI) / 180));
  const h = (b.north - b.south) * METERS_PER_DEGREE_LAT;
  return (w * h) / 1e6;
}

/** lng/lat -> integer tile-local coordinates at `extent` quantisation. */
export function toTileLocal(lng, lat, z, x, y, extent) {
  const { mx, my } = lngLatToMercator(lng, lat);
  const n = 2 ** z;
  return {
    u: Math.round((mx * n - x) * extent),
    v: Math.round((my * n - y) * extent),
  };
}

/** Inverse of {@link toTileLocal}. */
export function fromTileLocal(u, v, z, x, y, extent) {
  const n = 2 ** z;
  return mercatorToLngLat((x + u / extent) / n, (y + v / extent) / n);
}

/** Metres on the ground represented by one tile-local unit, at `lat`. */
export function tileUnitMeters(z, lat, extent) {
  return tileGroundMeters(z, lat) / extent;
}
