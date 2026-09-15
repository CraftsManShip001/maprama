/**
 * Korea 2000 / Unified CS (UTM-K, EPSG:5179) ⇄ WGS84-compatible lng/lat.
 * GRS80 ellipsoid, transverse Mercator: lat0 38°N, lon0 127.5°E, k0 0.9996,
 * false easting 1,000,000 m, false northing 2,000,000 m. (Korea 2000 / GRS80
 * differs from WGS84 by well under a metre, so no datum shift is applied.)
 * Formulas: Snyder, "Map Projections: A Working Manual" (1987), §8.
 */

const A = 6378137;
const F = 1 / 298.257222101;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);
const K0 = 0.9996;
const LAT0 = (38 * Math.PI) / 180;
const LON0 = (127.5 * Math.PI) / 180;
const FE = 1_000_000;
const FN = 2_000_000;

function meridianArc(phi: number): number {
  const e4 = E2 * E2;
  const e6 = e4 * E2;
  return (
    A *
    ((1 - E2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi -
      ((3 * E2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi) +
      ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi) -
      ((35 * e6) / 3072) * Math.sin(6 * phi))
  );
}

const M0 = meridianArc(LAT0);

/** lng/lat (degrees) → UTM-K `{x, y}` metres. */
export function lngLatToUtmk(lng: number, lat: number): { x: number; y: number } {
  const phi = (lat * Math.PI) / 180;
  const lam = (lng * Math.PI) / 180;
  const sin = Math.sin(phi);
  const cos = Math.cos(phi);
  const tan = Math.tan(phi);
  const N = A / Math.sqrt(1 - E2 * sin * sin);
  const T = tan * tan;
  const C = EP2 * cos * cos;
  const Aa = (lam - LON0) * cos;
  const M = meridianArc(phi);
  const x = FE + K0 * N * (Aa + ((1 - T + C) * Aa ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa ** 5) / 120);
  const y =
    FN +
    K0 * (M - M0 + N * tan * ((Aa * Aa) / 2 + ((5 - T + 9 * C + 4 * C * C) * Aa ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa ** 6) / 720));
  return { x, y };
}

/** UTM-K metres → lng/lat (degrees). */
export function utmkToLngLat(x: number, y: number): { lng: number; lat: number } {
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const M = M0 + (y - FN) / K0;
  const mu = M / (A * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 ** 3) / 256));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const sin1 = Math.sin(phi1);
  const cos1 = Math.cos(phi1);
  const tan1 = Math.tan(phi1);
  const C1 = EP2 * cos1 * cos1;
  const T1 = tan1 * tan1;
  const N1 = A / Math.sqrt(1 - E2 * sin1 * sin1);
  const R1 = (A * (1 - E2)) / (1 - E2 * sin1 * sin1) ** 1.5;
  const D = (x - FE) / (N1 * K0);
  const phi =
    phi1 -
    ((N1 * tan1) / R1) *
      ((D * D) / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4) / 24 + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6) / 720);
  const lam = LON0 + (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5) / 120) / cos1;
  return { lng: (lam * 180) / Math.PI, lat: (phi * 180) / Math.PI };
}
