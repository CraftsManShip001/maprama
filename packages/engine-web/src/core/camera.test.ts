import { describe, expect, it } from 'vitest';
import {
  CameraController,
  DIST_HARD_MAX,
  DIST_HARD_MIN,
  DIST_MAX,
  DIST_MIN,
  farFor,
  limitsInUnits,
  nearFor,
} from './camera.js';

/** The world scales an app is likely to pick (8 = default, 24 = "just make the camera go further"). */
const SCALES = [8, 16, 24];

describe('distance limits in meters', () => {
  it('defaults to the engine range at every world scale', () => {
    for (const u of SCALES) {
      expect(limitsInUnits({}, u)).toEqual({ min: DIST_MIN, max: DIST_MAX });
    }
  });

  it('clamps to the same distance in meters whatever unitMeters is', () => {
    for (const u of SCALES) {
      const cam = new CameraController();
      const { min, max } = limitsInUnits({ min: 120, max: 3330 }, u);
      cam.setDistanceLimits(min, max);
      // Far too close and far too far, in world units.
      cam.zoomTo(0.01);
      expect(cam.orbit.distance * u).toBeCloseTo(120, 6);
      cam.zoomTo(1e6);
      expect(cam.orbit.distance * u).toBeCloseTo(3330, 6);
    }
  });

  it('reaches the 3,330 m the default range cannot', () => {
    const cam = new CameraController();
    // The old behaviour: 150 world units is 1,200 m at 8 m per unit.
    cam.zoomTo(1e6);
    expect(cam.orbit.distance * 8).toBe(1200);
    const { min, max } = limitsInUnits({ max: 3330 }, 8);
    cam.setDistanceLimits(min, max);
    cam.zoomTo(1e6);
    expect(cam.orbit.distance * 8).toBeCloseTo(3330, 6);
  });

  it('applies to every path that changes the distance', () => {
    const cam = new CameraController();
    cam.setDistanceLimits(20, 60);
    // setCamera
    cam.set({ distance: 500 });
    expect(cam.orbit.distance).toBe(60);
    cam.set({ distance: 1 });
    expect(cam.orbit.distance).toBe(20);
    // gestures and the wheel go through zoomTo
    cam.zoomTo(1000);
    expect(cam.orbit.distance).toBe(60);
    // the zoom buttons pre-clamp with clampDistance
    expect(cam.clampDistance(cam.orbit.distance * 1.45)).toBe(60);
    expect(cam.clampDistance(5)).toBe(20);
    // an animated move lands inside the range too
    cam.set({ distance: 900 }, 100);
    cam.update(1);
    expect(cam.orbit.distance).toBe(60);
  });

  it('pulls the current distance back when the range narrows', () => {
    const cam = new CameraController();
    cam.zoomTo(140);
    cam.setDistanceLimits(14, 40);
    expect(cam.orbit.distance).toBe(40);
  });

  it('narrows a range the renderer cannot serve and says so', () => {
    const cam = new CameraController();
    expect(cam.setDistanceLimits(DIST_MIN, DIST_MAX)).toEqual({ min: DIST_MIN, max: DIST_MAX, clamped: false });
    // 24 m per unit, maxDistanceMeters 100 km -> 4,166 units.
    expect(cam.setDistanceLimits(0.1, 4166)).toEqual({ min: DIST_HARD_MIN, max: DIST_HARD_MAX, clamped: true });
    // crossed pair: max is raised to min
    expect(cam.setDistanceLimits(80, 20)).toEqual({ min: 80, max: 80, clamped: true });
  });
});

describe('frustum planes follow the distance', () => {
  it('keeps the classic planes up to the default range', () => {
    for (const d of [14, 36, 110, 150]) {
      expect(nearFor(d)).toBe(0.5);
      expect(farFor(d)).toBe(900);
    }
  });

  it('grows both beyond it, keeping the far:near ratio', () => {
    const d = 416; // 3,330 m at 8 m per unit
    expect(farFor(d)).toBeCloseTo(2496, 6);
    expect(nearFor(d)).toBeCloseTo(1.3867, 3);
    expect(farFor(d) / nearFor(d)).toBeCloseTo(farFor(150) / nearFor(150), 6);
  });

  it('is applied to the three camera', () => {
    const cam = new CameraController();
    cam.setDistanceLimits(14, 600);
    cam.set({ distance: 500 });
    cam.apply();
    expect(cam.camera.far).toBe(3000);
    expect(cam.camera.near).toBeCloseTo(500 / 300, 6);
  });
});
