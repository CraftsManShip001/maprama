/**
 * EPSG:5174 (Korean 1985 / Modified Central Belt) -> WGS 84 lng/lat.
 *
 * The 토지이음 (도시계획)시설정보 shapefiles are published in EPSG:5174, so a
 * source that reads them has to do the datum shift itself. The alternative —
 * shelling out to `ogr2ogr`/`pyproj` — would make a tile build depend on a GDAL
 * install, so the ~60 lines of geodesy live here instead and are pinned by
 * `test/kr-proj.test.ts` against PROJ's own numbers.
 *
 * The transformation chain is the one PROJ picks for
 * `EPSG:5174 -> EPSG:4326` ("Korean 1985 to WGS 84 (1)"):
 *
 * 1. inverse Transverse Mercator on the Bessel 1841 ellipsoid
 *    (`lat_0=38, lon_0=127.002890277778, k=1, x_0=200000, y_0=500000`);
 * 2. geodetic -> geocentric (Bessel);
 * 3. **Molodensky-Badekas**, coordinate-frame convention, about PROJ's pivot —
 *    *not* the 7-parameter `TOWGS84` string some of the `.prj` files carry.
 *    The two differ by several metres, and the .prj value is the one that is
 *    wrong for this dataset;
 * 4. geocentric -> geodetic (WGS 84).
 *
 * @module
 */

/** Bessel 1841. */
const BESSEL_A = 6377397.155;
const BESSEL_F = 1 / 299.1528128;
/** WGS 84. */
const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;

/** Projection constants of EPSG:5174. */
const LAT0 = (38 * Math.PI) / 180;
const LON0 = (127.002890277778 * Math.PI) / 180;
const K0 = 1;
const FALSE_EASTING = 200000;
const FALSE_NORTHING = 500000;

/**
 * "Korean 1985 to WGS 84 (1)" (EPSG:1188-family), as PROJ applies it:
 * Molodensky-Badekas, coordinate-frame rotation convention.
 */
const MB = {
  dx: -145.907,
  dy: 505.034,
  dz: 685.756,
  /** Arc seconds. */
  rx: -1.162,
  ry: 2.347,
  rz: 1.592,
  /** Parts per million. */
  s: 6.342,
  px: -3159521.31,
  py: 4068151.32,
  pz: 3748113.85,
} as const;

const ARCSEC = Math.PI / (180 * 3600);

/** Meridian arc length on Bessel, and the constants the inverse series needs. */
const E2 = 2 * BESSEL_F - BESSEL_F * BESSEL_F;
const EP2 = E2 / (1 - E2);
const E1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));

function meridianArc(lat: number): number {
  return (
    BESSEL_A *
    ((1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 * E2 * E2) / 256) * lat -
      ((3 * E2) / 8 + (3 * E2 * E2) / 32 + (45 * E2 * E2 * E2) / 1024) * Math.sin(2 * lat) +
      ((15 * E2 * E2) / 256 + (45 * E2 * E2 * E2) / 1024) * Math.sin(4 * lat) -
      ((35 * E2 * E2 * E2) / 3072) * Math.sin(6 * lat))
  );
}

const M0 = meridianArc(LAT0);

/** Inverse Transverse Mercator on Bessel 1841: EPSG:5174 metres -> Bessel lat/lng in radians. */
function inverseTransverseMercator(x: number, y: number): { lat: number; lng: number } {
  const M = M0 + (y - FALSE_NORTHING) / K0;
  const mu = M / (BESSEL_A * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 * E2 * E2) / 256));
  const phi1 =
    mu +
    ((3 * E1) / 2 - (27 * E1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * E1 ** 2) / 16 - (55 * E1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * E1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * E1 ** 4) / 512) * Math.sin(8 * mu);

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const tanPhi1 = Math.tan(phi1);
  const C1 = EP2 * cosPhi1 * cosPhi1;
  const T1 = tanPhi1 * tanPhi1;
  const N1 = BESSEL_A / Math.sqrt(1 - E2 * sinPhi1 * sinPhi1);
  const R1 = (BESSEL_A * (1 - E2)) / (1 - E2 * sinPhi1 * sinPhi1) ** 1.5;
  const D = (x - FALSE_EASTING) / (N1 * K0);

  const lat =
    phi1 -
    ((N1 * tanPhi1) / R1) *
      ((D * D) / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6) / 720);
  const lng =
    LON0 +
    (D -
      ((1 + 2 * T1 + C1) * D ** 3) / 6 +
      ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5) / 120) /
      cosPhi1;

  return { lat, lng };
}

function geodeticToGeocentric(lat: number, lng: number, a: number, f: number): [number, number, number] {
  const e2 = 2 * f - f * f;
  const N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return [N * Math.cos(lat) * Math.cos(lng), N * Math.cos(lat) * Math.sin(lng), N * (1 - e2) * Math.sin(lat)];
}

/** Bowring's method; the height it computes is discarded, we only want lat/lng. */
function geocentricToGeodetic(X: number, Y: number, Z: number, a: number, f: number): { lat: number; lng: number } {
  const e2 = 2 * f - f * f;
  const b = a * (1 - f);
  const ep2 = (a * a - b * b) / (b * b);
  const p = Math.hypot(X, Y);
  const th = Math.atan2(a * Z, b * p);
  const lat = Math.atan2(Z + ep2 * b * Math.sin(th) ** 3, p - e2 * a * Math.cos(th) ** 3);
  return { lat, lng: Math.atan2(Y, X) };
}

/** Molodensky-Badekas, coordinate-frame convention. */
function molodenskyBadekas(X: number, Y: number, Z: number): [number, number, number] {
  const rx = MB.rx * ARCSEC;
  const ry = MB.ry * ARCSEC;
  const rz = MB.rz * ARCSEC;
  const m = 1 + MB.s * 1e-6;
  const dX = X - MB.px;
  const dY = Y - MB.py;
  const dZ = Z - MB.pz;
  return [
    MB.px + MB.dx + m * (dX + rz * dY - ry * dZ),
    MB.py + MB.dy + m * (-rz * dX + dY + rx * dZ),
    MB.pz + MB.dz + m * (ry * dX - rx * dY + dZ),
  ];
}

/**
 * One EPSG:5174 easting/northing in metres to `[lng, lat]` in WGS 84 degrees.
 *
 * Agrees with PROJ to well under a millimetre over the Korean peninsula; see
 * `test/kr-proj.test.ts`.
 */
export function epsg5174ToWgs84(x: number, y: number): [number, number] {
  const { lat, lng } = inverseTransverseMercator(x, y);
  const [gx, gy, gz] = geodeticToGeocentric(lat, lng, BESSEL_A, BESSEL_F);
  const [tx, ty, tz] = molodenskyBadekas(gx, gy, gz);
  const out = geocentricToGeodetic(tx, ty, tz, WGS84_A, WGS84_F);
  return [(out.lng * 180) / Math.PI, (out.lat * 180) / Math.PI];
}
