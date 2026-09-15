import { describe, expect, it } from 'vitest';
import { createProjection, DEFAULT_UNIT_METERS, EARTH_RADIUS_METERS, haversineMeters, type LngLat } from './index.js';

const SEOUL: LngLat = { lng: 126.978, lat: 37.5665 };

/** Offsets a coordinate by (east, north) meters using the projection's own constants. */
function offsetMeters(origin: LngLat, eastM: number, northM: number): LngLat {
  return {
    lng: origin.lng + eastM / (111320 * Math.cos((origin.lat * Math.PI) / 180)),
    lat: origin.lat + northM / 110540,
  };
}

describe('createProjection', () => {
  const proj = createProjection({ origin: SEOUL });

  it('defaults to 8 meters per unit and maps origin to (0, 0)', () => {
    expect(DEFAULT_UNIT_METERS).toBe(8);
    expect(proj.unitMeters).toBe(8);
    const p = proj.toWorld(SEOUL);
    expect(p.x).toBeCloseTo(0, 12);
    expect(p.z).toBeCloseTo(0, 12);
  });

  it('uses +x = east and -z = north with the documented formula', () => {
    const east = proj.toWorld(offsetMeters(SEOUL, 1000, 0));
    expect(east.x).toBeCloseTo(125, 9);
    expect(east.z).toBeCloseTo(0, 9);
    const north = proj.toWorld(offsetMeters(SEOUL, 0, 1000));
    expect(north.x).toBeCloseTo(0, 9);
    expect(north.z).toBeCloseTo(-125, 9);
  });

  it('round-trips with < 0.5 m error at 5 km from origin in all directions', () => {
    for (let deg = 0; deg < 360; deg += 15) {
      const rad = (deg * Math.PI) / 180;
      const original = offsetMeters(SEOUL, 5000 * Math.sin(rad), 5000 * Math.cos(rad));
      const back = proj.toLngLat(proj.toWorld(original));
      expect(haversineMeters(original, back)).toBeLessThan(0.5);
    }
  });

  it('keeps projected distances within 1% of great-circle distance at 5 km', () => {
    for (let deg = 0; deg < 360; deg += 30) {
      const rad = (deg * Math.PI) / 180;
      const target = offsetMeters(SEOUL, 5000 * Math.sin(rad), 5000 * Math.cos(rad));
      const w = proj.toWorld(target);
      const projectedMeters = proj.unitsToMeters(Math.hypot(w.x, w.z));
      const trueMeters = haversineMeters(SEOUL, target);
      expect(Math.abs(projectedMeters - trueMeters) / trueMeters).toBeLessThan(0.01);
    }
  });

  it('respects a custom unitMeters and converts distances', () => {
    const p1 = createProjection({ origin: SEOUL, unitMeters: 1 });
    expect(p1.toWorld(offsetMeters(SEOUL, 250, 0)).x).toBeCloseTo(250, 9);
    expect(proj.metersToUnits(80)).toBe(10);
    expect(proj.unitsToMeters(10)).toBe(80);
  });

  it('works in the southern and western hemispheres', () => {
    const origin = { lng: -58.3816, lat: -34.6037 };
    const p = createProjection({ origin });
    const target = offsetMeters(origin, -3000, -4000);
    const back = p.toLngLat(p.toWorld(target));
    expect(haversineMeters(target, back)).toBeLessThan(0.5);
    expect(p.toWorld(target).z).toBeGreaterThan(0);
  });

  it('rejects invalid options', () => {
    expect(() => createProjection({ origin: SEOUL, unitMeters: 0 })).toThrow(RangeError);
    expect(() => createProjection({ origin: SEOUL, unitMeters: Number.NaN })).toThrow(RangeError);
    expect(() => createProjection({ origin: { lng: 200, lat: 0 } })).toThrow(RangeError);
  });
});

describe('haversineMeters', () => {
  it('returns 0 for identical points', () => {
    expect(haversineMeters(SEOUL, SEOUL)).toBe(0);
  });

  it('matches one degree of latitude on the mean-radius sphere', () => {
    const d = haversineMeters({ lng: 0, lat: 0 }, { lng: 0, lat: 1 });
    expect(d).toBeCloseTo((EARTH_RADIUS_METERS * Math.PI) / 180, 6);
  });

  it('is symmetric', () => {
    const b = { lng: 127.0276, lat: 37.4979 };
    expect(haversineMeters(SEOUL, b)).toBeCloseTo(haversineMeters(b, SEOUL), 9);
  });
});
