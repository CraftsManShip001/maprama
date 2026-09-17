/**
 * Web-Mercator slippy-tile maths (EPSG:3857 / XYZ) and the inverse of the
 * equirectangular local-tangent-plane projection `@maprama/protocol` uses.
 *
 * Every function here is pure and deterministic: the same lng/lat always maps to
 * the same tile and the same tile-local integer. That is what lets the pipeline
 * split the country into chunks and still produce one seamless archive.
 *
 * @module
 */

/** Metres per degree of longitude at the equator, as `@maprama/protocol` uses it. */
export const METERS_PER_DEGREE_LNG = 111320;
/** Metres per degree of latitude, as `@maprama/protocol` uses it. */
export const METERS_PER_DEGREE_LAT = 110540;
/** Web Mercator equatorial circumference, metres. */
export const EARTH_CIRCUMFERENCE = 40075016.685578488;

/** A geographic point, `[lng, lat]`. Tuples, not objects: there are billions of them. */
export type LngLat = readonly [number, number];

/** A slippy tile address. */
export interface TileXYZ {
  z: number;
  x: number;
  y: number;
}

/** A geographic box. Same field names as `@maprama/osm`'s `BBox`. */
export interface GeoBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** `WorldData` local units -> lng/lat. Exact inverse of `createProjection().toWorld`. */
export function worldToLngLat(
  origin: { lng: number; lat: number },
  unitMeters: number,
  x: number,
  z: number,
): LngLat {
  const cosLat0 = Math.max(Math.cos((origin.lat * Math.PI) / 180), 1e-12);
  return [
    origin.lng + (x * unitMeters) / (METERS_PER_DEGREE_LNG * cosLat0),
    origin.lat - (z * unitMeters) / METERS_PER_DEGREE_LAT,
  ];
}

/** lng/lat -> normalised Web Mercator, both in [0, 1); y grows south. */
export function lngLatToMercator(lng: number, lat: number): { mx: number; my: number } {
  const s = Math.sin((lat * Math.PI) / 180);
  return { mx: (lng + 180) / 360, my: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI) };
}

/** Normalised Web Mercator -> lng/lat. */
export function mercatorToLngLat(mx: number, my: number): LngLat {
  return [mx * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI];
}

/** The tile a coordinate belongs to. Stateless — this is the whole "which tile?" rule. */
export function tileOf(lng: number, lat: number, z: number): TileXYZ {
  const { mx, my } = lngLatToMercator(lng, lat);
  const n = 2 ** z;
  return { z, x: clampTile(Math.floor(mx * n), n), y: clampTile(Math.floor(my * n), n) };
}

function clampTile(v: number, n: number): number {
  return v < 0 ? 0 : v > n - 1 ? n - 1 : v;
}

/** Geographic bounds of tile z/x/y. */
export function tileBounds(z: number, x: number, y: number): GeoBounds {
  const n = 2 ** z;
  const nw = mercatorToLngLat(x / n, y / n);
  const se = mercatorToLngLat((x + 1) / n, (y + 1) / n);
  return { west: nw[0], north: nw[1], east: se[0], south: se[1] };
}

/** Ground size of a tile edge at `lat`, in metres. */
export function tileGroundMeters(z: number, lat: number): number {
  return (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}

/** lng/lat -> integer tile-local coordinates at `extent` quantisation. */
export function toTileLocal(
  lng: number,
  lat: number,
  z: number,
  x: number,
  y: number,
  extent: number,
): [number, number] {
  const { mx, my } = lngLatToMercator(lng, lat);
  const n = 2 ** z;
  return [Math.round((mx * n - x) * extent), Math.round((my * n - y) * extent)];
}

/**
 * lng/lat -> integer coordinates on the whole zoom level's grid, at `extent`
 * units per tile.
 *
 * Quantising once per *vertex* rather than once per (vertex, tile) pair is not
 * just faster: because `x * extent` is an integer,
 * `round(a - x·extent) === round(a) - x·extent` exactly, so a vertex shared by
 * two neighbouring tiles lands on the same integer in both. That is what makes
 * clipped edges meet across a tile boundary instead of missing by a unit.
 */
export function toGlobalLocal(lng: number, lat: number, z: number, extent: number): [number, number] {
  const { mx, my } = lngLatToMercator(lng, lat);
  const n = 2 ** z * extent;
  return [Math.round(mx * n), Math.round(my * n)];
}

/** Inverse of {@link toTileLocal}. */
export function fromTileLocal(
  u: number,
  v: number,
  z: number,
  x: number,
  y: number,
  extent: number,
): LngLat {
  const n = 2 ** z;
  return mercatorToLngLat((x + u / extent) / n, (y + v / extent) / n);
}

/** Metres on the ground represented by one tile-local unit, at `lat`. */
export function tileUnitMeters(z: number, lat: number, extent: number): number {
  return tileGroundMeters(z, lat) / extent;
}

/** Inclusive tile range covering a geographic box at zoom `z`. */
export function tileRange(b: GeoBounds, z: number): { x0: number; x1: number; y0: number; y1: number } {
  const n = 2 ** z;
  const nw = lngLatToMercator(b.west, b.north);
  const se = lngLatToMercator(b.east, b.south);
  return {
    x0: clampTile(Math.floor(nw.mx * n), n),
    x1: clampTile(Math.floor(se.mx * n), n),
    y0: clampTile(Math.floor(nw.my * n), n),
    y1: clampTile(Math.floor(se.my * n), n),
  };
}

/** Bounding box of a lng/lat ring. */
export function boundsOf(pts: readonly LngLat[]): GeoBounds {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const p of pts) {
    if (p[0] < west) west = p[0];
    if (p[0] > east) east = p[0];
    if (p[1] < south) south = p[1];
    if (p[1] > north) north = p[1];
  }
  return { west, east, south, north };
}
