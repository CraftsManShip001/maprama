import { describe, expect, it } from 'vitest';
import type { WorldPoint } from '@maprama/protocol';
import { CameraController, DIST_HARD_MAX, DIST_MAX, DIST_MIN } from './camera.js';
import { fitBounds, fitBoundsOrbit, type FitBoundsInput } from './fit-bounds.js';

const W = 390, H = 760;
const NO_PAD = { top: 0, right: 0, bottom: 0, left: 0 };

/** A square box of `half` world units around the origin (corners in the order the engine builds them). */
const box = (half: number, cx = 0, cz = 0): WorldPoint[] => [
  { x: cx - half, z: cz + half },
  { x: cx + half, z: cz + half },
  { x: cx + half, z: cz - half },
  { x: cx - half, z: cz - half },
];

const base = (over: Partial<FitBoundsInput> = {}): FitBoundsInput => ({
  corners: box(40),
  width: W,
  height: H,
  padding: NO_PAD,
  fovDeg: 40,
  pitch: 50,
  bearing: 28,
  minDistance: DIST_MIN,
  // The default engine range (150) frames only a ~56 unit box in portrait, so the geometry tests
  // use the renderer's hard ceiling and the limit tests set their own.
  maxDistance: DIST_HARD_MAX,
  startDistance: 36,
  ...over,
});

/** Screen positions of `points` for an orbit, from the real three camera. */
function screen(points: readonly WorldPoint[], o: { x: number; z: number; distance: number; pitch: number; bearing: number }) {
  const cam = new CameraController();
  cam.setDistanceLimits(0.01, 1e6);
  cam.setViewport(W, H);
  cam.set(o);
  cam.apply();
  return points.map((p) => cam.worldToScreen(p.x, 0, p.z));
}

describe('fit-bounds projection', () => {
  it('reproduces the three.js camera exactly', () => {
    // fitBoundsOrbit must agree with the renderer, or a "fitted" box would not really fit.
    const pts = box(30, 12, -7);
    const out = fitBoundsOrbit(base({ corners: pts }));
    const real = screen(pts, out);
    for (const s of real) {
      expect(s.x).toBeGreaterThanOrEqual(-0.5);
      expect(s.x).toBeLessThanOrEqual(W + 0.5);
      expect(s.y).toBeGreaterThanOrEqual(-0.5);
      expect(s.y).toBeLessThanOrEqual(H + 0.5);
    }
    expect(out.fitted).toBe(true);
  });
});

describe('fitBoundsOrbit geometry', () => {
  it('frames the box tightly: one axis touches the viewport edge', () => {
    const out = fitBoundsOrbit(base({ pitch: 0, bearing: 0, corners: box(40) }));
    const s = screen(box(40), out);
    const minX = Math.min(...s.map((p) => p.x)), maxX = Math.max(...s.map((p) => p.x));
    const minY = Math.min(...s.map((p) => p.y)), maxY = Math.max(...s.map((p) => p.y));
    // The portrait viewport is narrower than it is tall, so a square box fills the width.
    expect(minX).toBeCloseTo(0, 1);
    expect(maxX).toBeCloseTo(W, 1);
    expect(maxY - minY).toBeLessThanOrEqual(H + 0.5);
    expect(out.fitted).toBe(true);
  });

  it('honours padding in dp', () => {
    const pad = { top: 60, right: 20, bottom: 120, left: 20 };
    const corners = box(40);
    const out = fitBoundsOrbit(base({ pitch: 0, bearing: 0, corners, padding: pad }));
    const s = screen(corners, out);
    const minX = Math.min(...s.map((p) => p.x)), maxX = Math.max(...s.map((p) => p.x));
    const minY = Math.min(...s.map((p) => p.y)), maxY = Math.max(...s.map((p) => p.y));
    expect(minX).toBeGreaterThanOrEqual(pad.left - 0.5);
    expect(maxX).toBeLessThanOrEqual(W - pad.right + 0.5);
    expect(minY).toBeGreaterThanOrEqual(pad.top - 0.5);
    expect(maxY).toBeLessThanOrEqual(H - pad.bottom + 0.5);
    // The asymmetric padding moves the target: the box is centred in the free rectangle.
    expect((minY + maxY) / 2).toBeCloseTo(pad.top + (H - pad.top - pad.bottom) / 2, 0);
  });

  it('is scale invariant: a box twice as large needs twice the distance', () => {
    const small = fitBoundsOrbit(base({ corners: box(20) }));
    const large = fitBoundsOrbit(base({ corners: box(40) }));
    expect(large.distance / small.distance).toBeCloseTo(2, 2);
  });

  it('centres on the box', () => {
    const out = fitBoundsOrbit(base({ corners: box(30, 120, -45) }));
    const s = screen(box(30, 120, -45), out);
    const cx = (Math.min(...s.map((p) => p.x)) + Math.max(...s.map((p) => p.x))) / 2;
    const cy = (Math.min(...s.map((p) => p.y)) + Math.max(...s.map((p) => p.y))) / 2;
    expect(cx).toBeCloseTo(W / 2, 0);
    expect(cy).toBeCloseTo(H / 2, 0);
  });

  it('needs more distance at a pitch than looking straight down', () => {
    const flat = fitBoundsOrbit(base({ pitch: 0, bearing: 0 }));
    const tilted = fitBoundsOrbit(base({ pitch: 60, bearing: 0 }));
    expect(tilted.distance).toBeGreaterThan(flat.distance);
  });

  it('reports a box that does not fit inside the limits', () => {
    const out = fitBoundsOrbit(base({ corners: box(400), maxDistance: DIST_MAX }));
    expect(out.fitted).toBe(false);
    expect(out.distanceLimited).toBe(true);
    expect(out.distance).toBe(DIST_MAX);
    // It is still a usable camera: centred on the box, at the furthest the app allows.
    expect(out.x).toBeCloseTo(0, 1);
    expect(out.z).toBeCloseTo(0, 1);
  });

  it('reports a box smaller than the minimum distance can frame', () => {
    const out = fitBoundsOrbit(base({ corners: box(0.2), pitch: 0, bearing: 0 }));
    expect(out.distance).toBe(DIST_MIN);
    expect(out.distanceLimited).toBe(true);
    expect(out.fitted).toBe(true);
  });

  it('frames a degenerate (single point) box without dividing by zero', () => {
    const out = fitBoundsOrbit(base({ corners: box(0, 10, 10) }));
    expect(Number.isFinite(out.distance)).toBe(true);
    expect(out.distance).toBe(DIST_MIN);
  });
});

describe('fitBounds orientation', () => {
  // 214 units of distance frame this box straight down to north, 282 at pitch 60 / bearing 28.
  const tall = box(40);
  const tight = 250;

  it('keeps pitch and bearing when the box fits', () => {
    const out = fitBounds({ ...base({ corners: box(40) }), orientation: 'auto' });
    expect(out.pitch).toBe(50);
    expect(out.bearing).toBe(28);
    expect(out.fitted).toBe(true);
  });

  it('reset always looks straight down to north', () => {
    const out = fitBounds({ ...base({ corners: box(40) }), orientation: 'reset' });
    expect(out.pitch).toBe(0);
    expect(out.bearing).toBe(0);
  });

  it('auto falls back to straight down when that is what makes the box fit', () => {
    // A box that only fits without the perspective foreshortening of a pitch.
    const kept = fitBoundsOrbit(base({ corners: tall, pitch: 60, bearing: 28, maxDistance: tight }));
    const reset = fitBoundsOrbit(base({ corners: tall, pitch: 0, bearing: 0, maxDistance: tight }));
    expect(kept.fitted).toBe(false);
    expect(reset.fitted).toBe(true);
    const auto = fitBounds({ ...base({ corners: tall, pitch: 60, bearing: 28, maxDistance: tight }), orientation: 'auto' });
    expect(auto.pitch).toBe(0);
    expect(auto.fitted).toBe(true);
  });

  it('keep never resets, even when the box then does not fit', () => {
    const out = fitBounds({ ...base({ corners: tall, pitch: 60, bearing: 28, maxDistance: tight }), orientation: 'keep' });
    expect(out.pitch).toBe(60);
    expect(out.fitted).toBe(false);
  });
});
