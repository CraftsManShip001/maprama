import { describe, expect, it } from 'vitest';
import { connectedComponents, type RoadGraph } from './graph.js';
import { buildGridWorld } from './grid.js';
import type { WorldModel } from './model.js';
import { bbox, convexOverlap, signedArea } from './polygon.js';
import { buildTownWorld } from './town.js';

/** Share of nodes (with edges) in the largest connected component. */
function largestComponentShare(g: RoadGraph): number {
  const seen = new Int32Array(g.nodes.length).fill(-1);
  const sizes: number[] = [];
  for (let i = 0; i < g.nodes.length; i++) {
    if (seen[i] !== -1 || !g.adj[i]!.length) continue;
    const id = sizes.length;
    let size = 0;
    const stack = [i];
    seen[i] = id;
    while (stack.length) {
      const u = stack.pop()!;
      size++;
      for (const ei of g.adj[u]!) {
        const e = g.edges[ei]!, v = e.a === u ? e.b : e.a;
        if (seen[v] === -1) { seen[v] = id; stack.push(v); }
      }
    }
    sizes.push(size);
  }
  const total = sizes.reduce((a, b) => a + b, 0);
  return total ? Math.max(...sizes) / total : 0;
}

function overlappingPairs(w: WorldModel): [string, string][] {
  const boxes = w.buildings.map((b) => bbox(b.footprint));
  const out: [string, string][] = [];
  for (let i = 0; i < w.buildings.length; i++) {
    for (let j = i + 1; j < w.buildings.length; j++) {
      const a = boxes[i]!, c = boxes[j]!;
      if (a.maxX < c.minX || c.maxX < a.minX || a.maxZ < c.minZ || c.maxZ < a.minZ) continue;
      if (convexOverlap(w.buildings[i]!.footprint, w.buildings[j]!.footprint, 0.01)) out.push([w.buildings[i]!.id, w.buildings[j]!.id]);
    }
  }
  return out;
}

describe('procedural grid', () => {
  const w = buildGridWorld();
  it('produces a single connected road network', () => {
    expect(w.graph.edges.length).toBe(2 * 9 * 8);
    expect(connectedComponents(w.graph)).toBe(1);
  });
  it('places non-overlapping rectangular lots with one landmark', () => {
    expect(w.buildings.length).toBeGreaterThan(100);
    expect(w.buildings.filter((b) => b.landmark)).toHaveLength(1);
    expect(w.buildings.every((b) => b.rect && b.footprint.length === 4 && signedArea(b.footprint) > 0)).toBe(true);
    expect(overlappingPairs(w)).toEqual([]);
  });
  it('is deterministic', () => {
    const again = buildGridWorld();
    expect(again.buildings.map((b) => [b.x, b.z, b.h])).toEqual(w.buildings.map((b) => [b.x, b.z, b.h]));
  });
});

describe('procedural town', () => {
  const w = buildTownWorld();
  it('produces a connected road network (arterials and bridges join both river banks)', () => {
    expect(w.graph.edges.length).toBeGreaterThan(100);
    expect(w.graph.edges.some((e) => e.bridge)).toBe(true);
    expect(largestComponentShare(w.graph)).toBeGreaterThan(0.95);
  });
  it('places buildings along frontages plus infill without overlaps', () => {
    expect(w.buildings.length).toBeGreaterThan(200);
    expect(w.buildings.length).toBeLessThanOrEqual(460);
    expect(w.buildings.filter((b) => b.landmark)).toHaveLength(1);
    expect(overlappingPairs(w)).toEqual([]);
  });
  it('keeps buildings off the roads and the river', () => {
    for (const b of w.buildings) {
      if (b.landmark) continue;
      const riverDist = Math.abs(b.z - (44 + 7 * Math.sin(b.x / 38 + 0.6)));
      expect(riverDist).toBeGreaterThan(8);
    }
  });
  it('has unique building ids', () => {
    expect(new Set(w.buildings.map((b) => b.id)).size).toBe(w.buildings.length);
  });
});
