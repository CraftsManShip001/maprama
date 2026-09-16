import type { Vec2 } from '@maprama/protocol';
import { describe, expect, it } from 'vitest';
import { buildingAt, nearestOnRing, resolveWorldAnchor, snapToBuilding, type AnchorBuilding, type AnchorContext } from './anchor.js';

/** A 10×10 square with its lower-left corner at (x, z). */
const square = (id: string, x: number, z: number, size = 10): AnchorBuilding => ({
  id,
  footprint: [[x, z], [x + size, z], [x + size, z + size], [x, z + size]] as Vec2[],
});

const A = square('a', 0, 0);
const B = square('b', 30, 0);
const buildings = [A, B];

const ctx = (roofs: Record<string, number>, groundY = 0): AnchorContext => ({
  buildings,
  roofY: (id) => roofs[id] ?? null,
  groundY,
});

describe('nearestOnRing', () => {
  it('finds the closest point on the outline, inside or out', () => {
    const outside = nearestOnRing(-4, 5, A.footprint);
    expect(outside).toMatchObject({ x: 0, z: 5 });
    expect(Math.sqrt(outside.d2)).toBeCloseTo(4);
    // A point inside still reports the nearest *edge* — containment is the caller's test.
    const inside = nearestOnRing(2, 5, A.footprint);
    expect(Math.sqrt(inside.d2)).toBeCloseTo(2);
  });
});

describe('buildingAt', () => {
  it('returns the footprint that contains the point, or null', () => {
    expect(buildingAt(buildings, 5, 5)?.id).toBe('a');
    expect(buildingAt(buildings, 35, 5)?.id).toBe('b');
    expect(buildingAt(buildings, 20, 5)).toBeNull();
  });

  it('ignores degenerate rings', () => {
    expect(buildingAt([{ id: 'x', footprint: [[0, 0], [1, 1]] as Vec2[] }], 0, 0)).toBeNull();
  });
});

describe('snapToBuilding', () => {
  it('reports containment without moving the point', () => {
    const hit = snapToBuilding(buildings, 5, 5, 20, 1);
    expect(hit).toMatchObject({ x: 5, z: 5, distance: 0, inside: true });
    expect(hit?.building.id).toBe('a');
  });

  it('moves an outside point onto the nearest footprint and reports the distance', () => {
    const hit = snapToBuilding(buildings, -4, 5, 20, 1);
    expect(hit?.building.id).toBe('a');
    expect(hit?.inside).toBe(false);
    expect(hit?.distance).toBeCloseTo(4);
    // Pulled 1 unit past the outline, so it really is inside afterwards.
    expect(hit!.x).toBeCloseTo(1);
    expect(buildingAt(buildings, hit!.x, hit!.z)?.id).toBe('a');
  });

  it('picks the nearer of two candidates', () => {
    expect(snapToBuilding(buildings, 22, 5, 20, 1)?.building.id).toBe('b');
    expect(snapToBuilding(buildings, 14, 5, 20, 1)?.building.id).toBe('a');
  });

  it('returns null beyond the radius, and with a radius of 0 outside every footprint', () => {
    expect(snapToBuilding(buildings, -50, 5, 20, 1)).toBeNull();
    expect(snapToBuilding(buildings, -4, 5, 0, 1)).toBeNull();
    // ...but a radius of 0 still answers for a point that is inside.
    expect(snapToBuilding(buildings, 5, 5, 0, 1)?.inside).toBe(true);
  });

  it('falls back to the interior when the inset would overshoot a thin footprint', () => {
    const thin: AnchorBuilding = { id: 't', footprint: [[0, 0], [10, 0], [10, 0.4], [0, 0.4]] as Vec2[] };
    const hit = snapToBuilding([thin], 5, -2, 20, 5);
    expect(hit).not.toBeNull();
    expect(buildingAt([thin], hit!.x, hit!.z)?.id).toBe('t');
  });
});

describe('resolveWorldAnchor', () => {
  it('ground mode never looks at a building', () => {
    const a = resolveWorldAnchor(ctx({ a: 12 }), { x: 5, z: 5, mode: 'ground', height: 3 });
    expect(a).toEqual({ x: 5, z: 5, baseY: 0, height: 3 });
  });

  it('roof mode stands on the containing building', () => {
    const a = resolveWorldAnchor(ctx({ a: 12 }), { x: 5, z: 5, mode: 'roof', height: 3 });
    expect(a).toMatchObject({ baseY: 12, buildingId: 'a' });
    expect(a.snapDistance).toBeUndefined();
  });

  it('auto behaves like roof and falls back to the ground with no building', () => {
    expect(resolveWorldAnchor(ctx({ a: 12 }), { x: 5, z: 5, mode: 'auto', height: 3 }).buildingId).toBe('a');
    expect(resolveWorldAnchor(ctx({ a: 12 }), { x: 20, z: 5, mode: 'auto', height: 3 })).toEqual({ x: 20, z: 5, baseY: 0, height: 3 });
  });

  it('stays on the ground when the building is not drawn', () => {
    // `roofY` returns null for a building the renderer filtered out.
    const a = resolveWorldAnchor(ctx({}), { x: 5, z: 5, mode: 'roof', height: 3 });
    expect(a).toEqual({ x: 5, z: 5, baseY: 0, height: 3 });
  });

  it('snaps and records the distance when asked to', () => {
    const a = resolveWorldAnchor(ctx({ a: 12 }), { x: -4, z: 5, mode: 'roof', height: 3, snapDistance: 20, snapInset: 1 });
    expect(a.buildingId).toBe('a');
    expect(a.baseY).toBe(12);
    expect(a.snapDistance).toBeCloseTo(4);
    expect(a.x).toBeCloseTo(1);
  });
});
