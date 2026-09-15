import { describe, expect, it } from 'vitest';
import type { Vec2 } from '@diorama/protocol';
import {
  assembleRings,
  clipPolylineToRect,
  clipRingToRect,
  ensureCCW,
  interiorPoint,
  pointInRing,
  ringArea,
  signedArea,
  simplifyLine,
  simplifyRing,
} from '../src/geometry.js';

describe('winding', () => {
  it('treats positive shoelace area over [x, z] as counter-clockwise (protocol fixture convention)', () => {
    expect(signedArea([[1, 1], [5, 1], [5, 5], [1, 5]])).toBe(16);
    expect(signedArea([[1, 5], [5, 5], [5, 1], [1, 1]])).toBe(-16);
  });

  it('ensureCCW reverses clockwise rings only', () => {
    const cw: Vec2[] = [[1, 5], [5, 5], [5, 1], [1, 1]];
    expect(signedArea(ensureCCW(cw))).toBeGreaterThan(0);
    const ccw: Vec2[] = [[1, 1], [5, 1], [5, 5], [1, 5]];
    expect(ensureCCW(ccw)).toBe(ccw);
  });
});

describe('clipping', () => {
  const rect = { minX: 0, minZ: 0, maxX: 10, maxZ: 10 };

  it('clips a polygon to the rectangle', () => {
    const clipped = clipRingToRect([[5, 2], [15, 2], [15, 8], [5, 8]], rect);
    expect(ringArea(clipped)).toBeCloseTo(30);
    for (const [x, z] of clipped) {
      expect(x).toBeLessThanOrEqual(10);
      expect(z).toBeGreaterThanOrEqual(0);
    }
  });

  it('drops polygons fully outside', () => {
    expect(clipRingToRect([[20, 20], [30, 20], [30, 30]], rect)).toEqual([]);
  });

  it('splits a polyline that leaves and re-enters', () => {
    const pieces = clipPolylineToRect([[5, 2], [15, 5], [5, 8]], rect);
    expect(pieces).toHaveLength(2);
    expect(pieces[0]![pieces[0]!.length - 1]![0]).toBeCloseTo(10);
    expect(pieces[1]![0]![0]).toBeCloseTo(10);
  });

  it('keeps a fully inside polyline intact and clips crossing ends', () => {
    expect(clipPolylineToRect([[1, 1], [2, 2], [3, 1]], rect)).toEqual([[[1, 1], [2, 2], [3, 1]]]);
    expect(clipPolylineToRect([[-5, 5], [15, 5]], rect)).toEqual([[[0, 5], [10, 5]]]);
  });
});

describe('simplification', () => {
  it('removes collinear points within tolerance', () => {
    expect(simplifyLine([[0, 0], [1, 0.01], [2, 0]], 0.1)).toEqual([[0, 0], [2, 0]]);
    expect(simplifyLine([[0, 0], [1, 1], [2, 0]], 0.1)).toHaveLength(3);
  });

  it('never reduces a ring below 3 vertices', () => {
    const ring: Vec2[] = [[0, 0], [1, 0], [1, 0.001], [1, 1], [0, 1]];
    const s = simplifyRing(ring, 0.01);
    expect(s.length).toBeGreaterThanOrEqual(3);
    expect(ringArea(s)).toBeCloseTo(1, 2);
  });
});

describe('rings', () => {
  it('assembles split and reversed segments into a closed ring', () => {
    const k = (p: Vec2): string => p.join(',');
    const rings = assembleRings<Vec2>(
      [
        [[0, 0], [1, 0], [1, 1]],
        [[0, 0], [0, 1], [1, 1]],
        [[5, 5], [6, 6]],
      ],
      k,
    );
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(4);
    expect(ringArea(rings[0]!)).toBeCloseTo(1);
  });

  it('finds an interior point for concave rings', () => {
    const u: Vec2[] = [[0, 0], [3, 0], [3, 3], [2, 3], [2, 1], [1, 1], [1, 3], [0, 3]];
    expect(pointInRing(interiorPoint(u), u)).toBe(true);
  });
});
