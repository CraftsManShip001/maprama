/**
 * The EPSG:5174 -> WGS 84 transform, pinned against PROJ.
 *
 * Expected values come from `pyproj.Transformer.from_crs(5174, 4326,
 * always_xy=True)`, which resolves to the pipeline
 * `inv tmerc(bessel) | cart(bessel) | molobadekas(...) | inv cart(WGS84)`.
 * If this test ever fails, the datum shift has drifted, and every polygon the
 * `kr-parks` source emits is in the wrong place by metres.
 */

import { describe, expect, it } from 'vitest';
import { epsg5174ToWgs84 } from '../src/kr-proj.js';

/** `[easting, northing, lng, lat]`, PROJ 9 via pyproj. */
const PROJ_CASES: [number, number, number, number][] = [
  [200000, 500000, 127.00078354, 38.00274602],
  [190000, 540000, 126.88636135, 38.36304684],
  [210000, 460000, 127.1140912, 37.64231269],
  [198000, 552000, 126.97786083, 38.47120389],
  [205000, 447000, 127.05735167, 37.52522503],
  [160000, 300000, 126.5560427, 36.19979793],
  [250000, 600000, 127.57716499, 38.90217889],
];

describe('epsg5174ToWgs84', () => {
  it.each(PROJ_CASES)('agrees with PROJ at %i, %i', (x, y, lng, lat) => {
    const [gotLng, gotLat] = epsg5174ToWgs84(x, y);
    // 1e-8 degrees is about 1 mm.
    expect(gotLng).toBeCloseTo(lng, 7);
    expect(gotLat).toBeCloseTo(lat, 7);
  });

  it('puts the origin near the projection centre, shifted by the datum', () => {
    const [lng, lat] = epsg5174ToWgs84(200000, 500000);
    // The false origin is 127.0028903E / 38N on Bessel. The Korean 1985 -> WGS 84
    // shift moves it a few hundred metres: that shift is the whole point.
    expect(Math.abs(lng - 127.0028903)).toBeGreaterThan(0.001);
    expect(Math.abs(lat - 38)).toBeGreaterThan(0.001);
    expect(Math.abs(lng - 127.0028903)).toBeLessThan(0.01);
    expect(Math.abs(lat - 38)).toBeLessThan(0.01);
  });

  it('is locally isometric: 1 m of easting is 1 m of longitude', () => {
    const [lng0, lat0] = epsg5174ToWgs84(200000, 440000);
    const [lng1] = epsg5174ToWgs84(200100, 440000);
    const [, lat1] = epsg5174ToWgs84(200000, 440100);
    const metersPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
    expect((lng1 - lng0) * metersPerDegLng).toBeCloseTo(100, 0);
    expect((lat1 - lat0) * 110900).toBeCloseTo(100, 0);
  });
});
