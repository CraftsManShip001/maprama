import { describe, expect, it } from 'vitest';
import type { Fog } from 'three';
import { renderParamsFor } from '../theme/params.js';
import { farFor } from '../core/camera.js';
import { RANGE_REF, rangeScale, ZoomOutController, zoomOutTarget } from './zoom-out.js';

const params = renderParamsFor({ base: 'urban', timeOfDay: 'day' });

/** Runs the controller to rest at a distance and reports what it applied. */
function settle(distance: number, behavior: typeof params.zoomOut = 'keepGameView'): { fog: { near: number; far: number }; shadow: { extent: number; far: number }; t: number } {
  const ctrl = new ZoomOutController();
  const fog = { near: 0, far: 0 } as Fog;
  const shadow = { left: 0, right: 0, top: 0, bottom: 0, far: 0, updateProjectionMatrix() {} };
  const clutter = { visible: true };
  const p = { ...params, zoomOut: behavior };
  // reduceMotion = true steps straight to the target.
  ctrl.update(1, distance, p, { fog, shadowCamera: shadow, clutter, setHazeFade: () => {} }, true);
  return { fog: { near: fog.near, far: fog.far }, shadow: { extent: shadow.right, far: shadow.far }, t: ctrl.t };
}

describe('rangeScale', () => {
  it('is 1 for every distance the engine could reach before metre limits existed', () => {
    for (const d of [14, 36, 55, 110, 150]) expect(rangeScale(d)).toBe(1);
    expect(RANGE_REF).toBe(150);
  });

  it('grows linearly beyond it', () => {
    expect(rangeScale(300)).toBe(2);
    expect(rangeScale(416)).toBeCloseTo(2.7733, 4);
  });
});

describe('fog and shadow ranges at long distance', () => {
  it('leaves the classic look untouched inside the default range', () => {
    // Exactly the numbers the controller applied before this feature.
    expect(settle(150).fog).toEqual({ near: params.fog.near + 110, far: params.fog.far + 260 });
    expect(settle(150).shadow).toEqual({ extent: 48 + 95, far: 160 + 200 });
    expect(settle(36).fog).toEqual({ near: params.fog.near, far: params.fog.far });
  });

  it('keeps the camera well inside the fog at a 3,330 m view', () => {
    const d = 416; // 3,330 m at 8 m per world unit
    const wide = settle(d);
    // Without the stretch the fog far plane would be 410 units — behind the camera itself.
    expect(wide.fog.far).toBeGreaterThan(d * 2);
    expect(wide.fog.near).toBeGreaterThan(d);
    // ...and the frustum still reaches past the fog, so nothing is clipped before it fades out.
    expect(farFor(d)).toBeGreaterThan(wide.fog.far);
  });

  it('puts the fog fade at the same place on screen as it is at the default limit', () => {
    // The furthest ground point a pitched camera sees is ~1.674 * distance away from it.
    const fade = (d: number): number => {
      const s = settle(d);
      return (1.674 * d - s.fog.near) / (s.fog.far - s.fog.near);
    };
    expect(fade(416)).toBeCloseTo(fade(150), 6);
    expect(fade(900)).toBeCloseTo(fade(150), 6);
  });

  it('stretches with `zoomOut: none` too, where the factor never rises', () => {
    const none = settle(416, 'none');
    expect(none.t).toBe(0);
    expect(none.fog).toEqual({ near: params.fog.near * rangeScale(416), far: params.fog.far * rangeScale(416) });
    expect(zoomOutTarget('none', 416)).toBe(0);
  });

  it('re-applies when only the distance (not the factor) changed', () => {
    const ctrl = new ZoomOutController();
    const fog = { near: 0, far: 0 } as Fog;
    const shadow = { left: 0, right: 0, top: 0, bottom: 0, far: 0, updateProjectionMatrix() {} };
    const targets = { fog, shadowCamera: shadow, clutter: { visible: true }, setHazeFade: () => {} };
    const keep = { ...params, zoomOut: 'keepGameView' as const };
    ctrl.update(1, 300, keep, targets, true);
    const at300 = fog.far;
    // The factor is already 1 at both distances; only the stretch differs.
    ctrl.update(1, 600, keep, targets, true);
    expect(ctrl.t).toBe(1);
    expect(fog.far).toBeCloseTo(at300 * 2, 6);
  });
});
