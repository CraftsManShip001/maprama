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
  PITCH_MAX,
  PITCH_MIN,
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

describe('content inset', () => {
  /** A controller sized like a phone, looking at a known ground point. */
  const phone = (inset?: { top?: number; right?: number; bottom?: number; left?: number }): CameraController => {
    const cam = new CameraController();
    cam.setViewport(390, 760);
    cam.setInset(inset);
    cam.set({ x: 10, z: -20, distance: 60, pitch: 50, bearing: 28 });
    cam.apply();
    return cam;
  };

  it('is the whole view without an inset', () => {
    const cam = phone();
    expect(cam.view).toEqual({ x: 0, y: 0, width: 390, height: 760 });
    expect(cam.insetShift()).toEqual({ x: 0, z: 0 });
  });

  it('shrinks the visible area by the inset', () => {
    const cam = phone({ top: 56, bottom: 380, left: 8 });
    expect(cam.view).toEqual({ x: 8, y: 56, width: 382, height: 324 });
  });

  it('never leaves a zero-sized visible area for an over-large inset', () => {
    const cam = phone({ top: 900, bottom: 900 });
    expect(cam.view.height).toBeGreaterThanOrEqual(1);
    expect(cam.view.y).toBeLessThan(760);
  });

  it('puts the camera target under the centre of the visible area, not the viewport', () => {
    const plain = phone();
    const inset = phone({ bottom: 380 });
    const at = (cam: CameraController) => cam.worldToScreen(cam.orbit.x, cam.groundY, cam.orbit.z);
    // Without an inset the target sits at the centre of the whole view.
    expect(at(plain).x).toBeCloseTo(195, 3);
    expect(at(plain).y).toBeCloseTo(380, 3);
    // With a 380 dp sheet at the bottom it sits at the centre of the top half.
    expect(at(inset).x).toBeCloseTo(195, 3);
    expect(at(inset).y).toBeCloseTo(190, 3);
  });

  it('keeps the same ground point centred when the distance, pitch or bearing changes', () => {
    const cam = phone({ bottom: 380, top: 56 });
    const centre = () => cam.screenToGround(cam.view.x + cam.view.width / 2, cam.view.y + cam.view.height / 2);
    const before = centre()!;
    for (const change of [{ distance: 240 }, { pitch: 20 }, { bearing: -140 }]) {
      cam.set(change);
      cam.apply();
      const now = centre()!;
      expect(now.x).toBeCloseTo(before.x, 3);
      expect(now.z).toBeCloseTo(before.z, 3);
    }
  });

  it('reports `visible` against the visible area while keeping full-view coordinates', () => {
    const cam = phone({ bottom: 380 });
    // A point low on the screen, under the sheet: real coordinates, but not visible.
    const under = cam.screenToGround(195, 600)!;
    const s = cam.worldToScreen(under.x, cam.groundY, under.z);
    expect(s.y).toBeCloseTo(600, 3);
    expect(s.visible).toBe(false);
    const above = cam.screenToGround(195, 150)!;
    expect(cam.worldToScreen(above.x, cam.groundY, above.z).visible).toBe(true);
  });
});

describe('visible ground corners (camera:idle bounds)', () => {
  const cam = (pitch: number, inset?: { top?: number; bottom?: number }): CameraController => {
    const c = new CameraController();
    c.setViewport(390, 760);
    c.setInset(inset);
    c.set({ x: 0, z: 0, distance: 100, pitch, bearing: 0 });
    c.apply();
    return c;
  };

  it('returns four corners in top-left, top-right, bottom-right, bottom-left order', () => {
    const corners = cam(0).groundCorners(6 * 100);
    expect(corners).toHaveLength(4);
    // Looking straight down with bearing 0: -z is north (the top of the screen).
    expect(corners[0]!.z).toBeLessThan(0);
    expect(corners[3]!.z).toBeGreaterThan(0);
    expect(corners[0]!.x).toBeLessThan(corners[1]!.x);
  });

  it('never reports a corner past the horizon clamp, whatever the pitch', () => {
    const limit = 6 * 100;
    for (const pitch of [0, 30, 50, 60]) {
      for (const c of cam(pitch).groundCorners(limit)) {
        expect(Math.hypot(c.x, c.z)).toBeLessThanOrEqual(limit + 1e-6);
      }
    }
  });

  it('shrinks with a bottom inset: the sheet hides the near edge', () => {
    const full = cam(50).groundCorners(600);
    const sheet = cam(50, { bottom: 380 }).groundCorners(600);
    const depth = (cs: { z: number }[]) => Math.max(...cs.map((c) => c.z)) - Math.min(...cs.map((c) => c.z));
    expect(depth(sheet)).toBeLessThan(depth(full));
  });
});

describe('camera:idle reason', () => {
  it('is honest about who moved the camera', () => {
    const cam = new CameraController();
    cam.setViewport(390, 760);
    cam.set({ distance: 50 });
    expect(cam.moveReason).toBe('api');
    cam.panBy(1, 1);
    expect(cam.moveReason).toBe('gesture');
    cam.set({ distance: 80 });
    expect(cam.moveReason).toBe('api');
    cam.zoomTo(40);
    expect(cam.moveReason).toBe('gesture');
    cam.rotateBy(10, 0);
    expect(cam.moveReason).toBe('gesture');
    // Following a character that is not where the camera is: the easing owns the move.
    cam.set({ x: 0, z: 0 });
    cam.follow(() => ({ x: 30, z: 30 }), 'me');
    cam.update(0.2);
    expect(cam.moveReason).toBe('follow');
  });
});

describe('pitch limits (the 2D view owns the pitch)', () => {
  const fresh = (): CameraController => {
    const c = new CameraController();
    c.setViewport(390, 760);
    c.set({ pitch: 50, bearing: 20, distance: 40 });
    return c;
  };

  it('defaults to the full range and is not locked', () => {
    const c = fresh();
    expect(c.pitchLimits).toEqual({ min: PITCH_MIN, max: PITCH_MAX });
    expect(c.pitchLocked).toBe(false);
  });

  it('pins the pitch immediately when the window closes', () => {
    const c = fresh();
    c.setPitchLimits(0, 0);
    expect(c.orbit.pitch).toBe(0);
    expect(c.pitchLocked).toBe(true);
  });

  it('refuses a pitch from set() and from a gesture while pinned', () => {
    const c = fresh();
    c.setPitchLimits(0, 0);
    c.set({ pitch: 45 });
    expect(c.orbit.pitch).toBe(0);
    c.rotateBy(30, 25);
    expect(c.orbit.pitch).toBe(0);
    // …while the bearing keeps turning: only the tilt is locked.
    expect(c.orbit.bearing).toBe(50);
  });

  it('re-clamps a running camera transition without cancelling it', () => {
    const c = fresh();
    c.set({ x: 100, z: 100, distance: 90, pitch: 60 }, 1000);
    c.setPitchLimits(0, 0);
    c.update(0.5);
    expect(c.orbit.pitch).toBe(0);
    // The rest of the transition is untouched: it is still on its way to (100, 100) at distance 90.
    expect(c.orbit.x).toBeGreaterThan(0);
    expect(c.orbit.x).toBeLessThan(100);
    expect(c.animating).toBe(true);
    c.update(1);
    expect(c.orbit.x).toBeCloseTo(100, 6);
    expect(c.orbit.distance).toBeCloseTo(90, 6);
    expect(c.orbit.pitch).toBe(0);
  });

  it('keeps "to north" flat while the pitch is pinned', () => {
    const c = fresh();
    c.setPitchLimits(0, 0);
    c.toNorth();
    for (let i = 0; i < 300 && c.animating; i++) c.update(1 / 60);
    expect(c.orbit.bearing).toBe(0);
    expect(c.orbit.pitch).toBe(0);
  });

  it('restores the full range and lets the pitch come back', () => {
    const c = fresh();
    c.setPitchLimits(0, 0);
    c.setPitchLimits(PITCH_MIN, PITCH_MAX);
    expect(c.pitchLocked).toBe(false);
    c.set({ pitch: 42 });
    expect(c.orbit.pitch).toBe(42);
  });
});
