import { describe, expect, it } from 'vitest';
import { buildGraph, connectedComponents, polylineLength, route, snap, type GraphRoad } from './graph.js';

const road = (id: string, pts: [number, number][], cls: GraphRoad['cls'] = 'local'): GraphRoad => ({ id, cls, pts });

describe('buildGraph (planarize + prune)', () => {
  it('splits crossing roads into a 4-way junction', () => {
    const g = buildGraph([road('h', [[-10, 0], [10, 0]]), road('v', [[0, -10], [0, 10]])]);
    expect(g.nodes).toHaveLength(5);
    expect(g.edges).toHaveLength(4);
    const center = g.nodes.findIndex((n) => Math.abs(n.x) < 1e-9 && Math.abs(n.z) < 1e-9);
    expect(center).toBeGreaterThanOrEqual(0);
    expect(g.adj[center]).toHaveLength(4);
    expect(g.edges.every((e) => Math.abs(e.len - 10) < 1e-9)).toBe(true);
    expect(new Set(g.edges.map((e) => e.roadId))).toEqual(new Set(['h', 'v']));
  });

  it('splits at T junctions and merges shared endpoints', () => {
    const g = buildGraph([road('a', [[0, 0], [20, 0]]), road('b', [[10, 0], [10, 15]]), road('c', [[20, 0], [20, 10]])]);
    expect(g.edges).toHaveLength(4);
    expect(connectedComponents(g)).toBe(1);
  });

  it('prunes short dangling stubs but keeps short connecting edges', () => {
    // stub of length 1 hanging off the crossing is removed
    const g = buildGraph([road('h', [[-10, 0], [10, 0]]), road('stub', [[5, 0], [5, 1]]), road('v', [[0, -10], [0, 10]])]);
    expect(g.edges.some((e) => e.roadId === 'stub')).toBe(false);
    expect(g.edges.filter((e) => e.roadId === 'h').length).toBe(3);
  });

  it('keeps class, name and bridge flags', () => {
    const g = buildGraph([{ id: 'br', cls: 'arterial', name: 'Bridge', bridge: true, pts: [[0, 0], [0, 20]] }]);
    expect(g.edges[0]).toMatchObject({ cls: 'arterial', name: 'Bridge', bridge: true, roadId: 'br' });
  });
});

describe('snap', () => {
  const g = buildGraph([road('h', [[-10, 0], [10, 0]]), road('v', [[0, -10], [0, 10]])]);
  it('returns the nearest point on an edge with distance', () => {
    const s = snap(g, 4, 3)!;
    expect(s.x).toBeCloseTo(4);
    expect(s.z).toBeCloseTo(0);
    expect(s.dist).toBeCloseTo(3);
    expect(g.edges[s.e]!.roadId).toBe('h');
  });
  it('clamps beyond segment ends', () => {
    const s = snap(g, 15, 0.5)!;
    expect(s.x).toBeCloseTo(10);
    expect(s.t === 0 || s.t === 1).toBe(true);
  });
  it('returns null for an empty graph', () => {
    expect(snap(buildGraph([]), 0, 0)).toBeNull();
  });
});

describe('route (Dijkstra)', () => {
  // 3×3 grid of 10-unit blocks
  const roads: GraphRoad[] = [];
  for (let i = 0; i <= 3; i++) {
    roads.push(road(`v${i}`, [[i * 10, 0], [i * 10, 30]]));
    roads.push(road(`h${i}`, [[0, i * 10], [30, i * 10]]));
  }
  const g = buildGraph(roads);

  it('finds a shortest Manhattan path', () => {
    const a = snap(g, 0, 0)!, b = snap(g, 30, 30)!;
    const path = route(g, a, b);
    expect(polylineLength(path)).toBeCloseTo(60);
    expect(path[0]).toEqual({ x: a.x, z: a.z });
    expect(path[path.length - 1]).toEqual({ x: b.x, z: b.z });
  });

  it('routes directly along the same edge', () => {
    const a = snap(g, 2, 0.2)!, b = snap(g, 8, -0.1)!;
    expect(route(g, a, b)).toHaveLength(2);
  });

  it('returns a single point when unreachable', () => {
    const g2 = buildGraph([road('a', [[0, 0], [10, 0]]), road('b', [[50, 50], [60, 50]])]);
    const p = route(g2, snap(g2, 1, 0)!, snap(g2, 55, 50)!);
    expect(p).toHaveLength(1);
    expect(connectedComponents(g2)).toBe(2);
  });
});
