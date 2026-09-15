import type { WorldData } from '@maprama/protocol';
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../util/math.js';
import { loadWorldData } from '../world/data.js';
import { buildGridWorld } from '../world/grid.js';
import { buildDemoLoop, GpsSmoother, locationTrip, SimulatedWalker } from './location.js';

const straight = loadWorldData({
  version: 1, name: 'Loc', origin: { lng: 127, lat: 37.5 }, unitMeters: 8, bounds: { minX: -100, minZ: -40, maxX: 100, maxZ: 40 },
  roads: [{ id: 'main', cls: 'arterial', pts: [[-100, 0], [100, 0]] }, { id: 'cross', cls: 'local', pts: [[0, -40], [0, 40]] }],
  buildings: [], water: [], parks: [], pois: [], stations: [], districts: [], attribution: [],
} satisfies WorldData);

describe('GpsSmoother', () => {
  it('starts at the first fix', () => {
    const s = new GpsSmoother();
    expect(s.push({ x: 3, z: 4, t: 0 })).toMatchObject({ x: 3, z: 4, rejected: false });
  });

  it('rejects a single outlier and keeps the estimate near the track', () => {
    const s = new GpsSmoother();
    for (let t = 0; t < 5; t++) s.push({ x: 0, z: 0, t });
    const r = s.push({ x: 40, z: 0, t: 5 });
    expect(new GpsSmoother().push({ x: 1, z: 1, t: 0 }).rejected).toBe(false);
    expect(r.rejected).toBe(true);
    expect(Math.hypot(r.x, r.z)).toBeLessThan(0.5);
    expect(s.push({ x: 0.2, z: 0, t: 6 }).rejected).toBe(false);
  });

  it('recovers from a real jump after consecutive consistent rejections', () => {
    const s = new GpsSmoother({ maxConsecutiveRejects: 3 });
    for (let t = 0; t < 5; t++) s.push({ x: 0, z: 0, t });
    expect(s.push({ x: 60, z: 0, t: 5 }).rejected).toBe(true);
    expect(s.push({ x: 60, z: 0, t: 6 }).rejected).toBe(true);
    const r = s.push({ x: 60, z: 0, t: 7 });
    expect(r.rejected).toBe(false);
    expect(r.x).toBe(60);
  });

  it('rejects fixes whose reported accuracy is too poor', () => {
    const s = new GpsSmoother({ maxAccuracyUnits: 10 });
    s.push({ x: 0, z: 0, t: 0 });
    expect(s.push({ x: 1, z: 0, t: 1, accuracy: 25 }).rejected).toBe(true);
    expect(s.push({ x: 1, z: 0, t: 2, accuracy: 2 }).rejected).toBe(false);
  });

  it('smooths noisy simulated fixes: lower error than the raw fixes', () => {
    const walker = new SimulatedWalker(buildDemoLoop(buildGridWorld(0)), mulberry32(42));
    const s = new GpsSmoother();
    let rawErr = 0, estErr = 0, n = 0, rejected = 0, outliers = 0, t = 0;
    for (let i = 0; i < 3000; i++) {
      t += 0.05;
      const fix = walker.step(0.05);
      if (!fix) continue;
      const r = s.push({ x: fix.x, z: fix.z, t });
      if (fix.outlier) outliers++;
      if (r.rejected) rejected++;
      if (n++ < 5) continue; // warm-up
      rawErr += Math.hypot(fix.x - walker.truth.x, fix.z - walker.truth.z);
      estErr += Math.hypot(r.x - walker.truth.x, r.z - walker.truth.z);
    }
    expect(n).toBeGreaterThan(100);
    expect(outliers).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
    expect(estErr).toBeLessThan(rawErr);
  });
});

describe('road matching and demo loop', () => {
  it('routes along the network to an estimate near a road, straight when far from roads', () => {
    const on = locationTrip(straight.graph, { x: -10, z: 0 }, { x: 0.5, z: 10 });
    expect(on.pts[0]).toEqual({ x: -10, z: 0 });
    expect(on.pts.some((p) => p.x === 0 && p.z === 0)).toBe(true);
    expect(on.speed).toBeGreaterThan(0);
    expect(on.speed).toBeLessThanOrEqual(8);
    const off = locationTrip(straight.graph, { x: 50, z: 20 }, { x: 50, z: 30 });
    expect(off.pts).toEqual([{ x: 50, z: 20 }, { x: 50, z: 30 }]);
    expect(locationTrip(straight.graph, { x: 1, z: 0 }, { x: 1.1, z: 0 }).speed).toBe(0);
  });

  it('builds a loop for worlds without loopWays (real data)', () => {
    const loop = buildDemoLoop(straight);
    expect(loop.length).toBeGreaterThan(2);
    for (const p of loop) expect(Math.min(Math.abs(p.z), Math.abs(p.x))).toBeLessThan(1e-6);
  });
});
