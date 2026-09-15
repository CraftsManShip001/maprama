/**
 * Road graph: planarization of road polylines into nodes/edges, pruning of
 * short dangling stubs, nearest-edge snapping and shortest-path routing
 * (binary-heap Dijkstra). Ported from the prototype's `buildGraph`, `snap`
 * and `route`. Pure: no three.js, no DOM.
 *
 * @module
 */

import type { RoadClass, Vec2 } from '@maprama/protocol';
import { clamp } from '../util/math.js';

/** Road width (world units) per class. */
export const ROAD_W: Readonly<Record<RoadClass, number>> = Object.freeze({ arterial: 3.0, local: 2.0, alley: 1.3 });

/** Input road polyline. */
export interface GraphRoad {
  id: string;
  name?: string;
  cls: RoadClass;
  bridge?: boolean;
  pts: Vec2[];
}

export interface GraphNode {
  x: number;
  z: number;
}

export interface GraphEdge {
  a: number;
  b: number;
  cls: RoadClass;
  /** Id of the source road. */
  roadId: string;
  name?: string;
  bridge: boolean;
  len: number;
}

/** A planar road network. */
export interface RoadGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Edge indices incident to each node. */
  adj: number[][];
  /** The source roads. */
  roads: GraphRoad[];
}

/** A point on an edge. */
export interface SnapResult {
  x: number;
  z: number;
  /** Edge index. */
  e: number;
  /** Parameter along the edge from `a` (0) to `b` (1). */
  t: number;
  /** Distance from the query point, world units. */
  dist: number;
}

export interface BuildGraphOptions {
  /** Edges shorter than this with a dangling end are pruned (default 2.5). */
  pruneLength?: number;
  /** Minimum segment length kept after splitting (default 0.3). */
  minSegment?: number;
}

/**
 * Builds a planar graph: every pair of segments is intersected, segments are
 * split at crossings, nodes are merged on a 0.5-unit key grid, duplicate
 * edges are dropped and short dangling edges are pruned iteratively.
 */
export function buildGraph(roads: GraphRoad[], opts: BuildGraphOptions = {}): RoadGraph {
  const pruneLength = opts.pruneLength ?? 2.5;
  const minSegment = opts.minSegment ?? 0.3;
  const nodes: GraphNode[] = [];
  let edges: GraphEdge[] = [];
  let adj: number[][] = [];
  const nodeKey = new Map<string, number>();
  const node = (x: number, z: number): number => {
    const k = Math.round(x * 2) + ':' + Math.round(z * 2);
    const found = nodeKey.get(k);
    if (found !== undefined) return found;
    const id = nodes.length;
    nodes.push({ x, z });
    adj.push([]);
    nodeKey.set(k, id);
    return id;
  };
  const edge = (a: number, b: number, r: GraphRoad): void => {
    if (a === b) return;
    for (const ei of adj[a]!) {
      const e = edges[ei]!;
      if (e.a === b || e.b === b) return;
    }
    const A = nodes[a]!, B = nodes[b]!;
    adj[a]!.push(edges.length);
    adj[b]!.push(edges.length);
    const e: GraphEdge = { a, b, cls: r.cls, roadId: r.id, bridge: !!r.bridge, len: Math.hypot(B.x - A.x, B.z - A.z) };
    if (r.name !== undefined) e.name = r.name;
    edges.push(e);
  };

  interface Seg { ri: number; a: Vec2; b: Vec2; ts: number[] }
  const segs: Seg[] = [];
  roads.forEach((r, ri) => {
    for (let i = 0; i < r.pts.length - 1; i++) segs.push({ ri, a: r.pts[i]!, b: r.pts[i + 1]!, ts: [0, 1] });
  });
  // bbox pre-check keeps the O(n²) pass fast for real data
  const boxes = segs.map((s) => [Math.min(s.a[0], s.b[0]), Math.min(s.a[1], s.b[1]), Math.max(s.a[0], s.b[0]), Math.max(s.a[1], s.b[1])] as const);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!, bs = boxes[i]!;
    for (let j = i + 1; j < segs.length; j++) {
      const bt = boxes[j]!;
      if (bt[0] > bs[2] + 1e-6 || bt[2] < bs[0] - 1e-6 || bt[1] > bs[3] + 1e-6 || bt[3] < bs[1] - 1e-6) continue;
      const t = segs[j]!;
      const rx = s.b[0] - s.a[0], rz = s.b[1] - s.a[1], qx = t.b[0] - t.a[0], qz = t.b[1] - t.a[1];
      const den = rx * qz - rz * qx;
      if (Math.abs(den) < 1e-9) continue;
      const wx = t.a[0] - s.a[0], wz = t.a[1] - s.a[1];
      const u = (wx * qz - wz * qx) / den, v = (wx * rz - wz * rx) / den;
      if (u > 1e-6 && u < 1 - 1e-6 && v >= -1e-6 && v <= 1 + 1e-6) s.ts.push(u);
      if (v > 1e-6 && v < 1 - 1e-6 && u >= -1e-6 && u <= 1 + 1e-6) t.ts.push(v);
    }
  }
  for (const s of segs) {
    const r = roads[s.ri]!;
    const ts = [...new Set(s.ts.map((t) => Math.round(t * 1e5) / 1e5))].sort((a, b) => a - b);
    for (let k = 0; k < ts.length - 1; k++) {
      const x0 = s.a[0] + (s.b[0] - s.a[0]) * ts[k]!, z0 = s.a[1] + (s.b[1] - s.a[1]) * ts[k]!;
      const x1 = s.a[0] + (s.b[0] - s.a[0]) * ts[k + 1]!, z1 = s.a[1] + (s.b[1] - s.a[1]) * ts[k + 1]!;
      if (Math.hypot(x1 - x0, z1 - z0) < minSegment) continue;
      edge(node(x0, z0), node(x1, z1), r);
    }
  }
  const dead = new Uint8Array(edges.length);
  const deg = (n: number): number => adj[n]!.filter((ei) => !dead[ei]).length;
  for (let changed = true; changed; ) {
    changed = false;
    edges.forEach((e, i) => {
      if (!dead[i] && e.len < pruneLength && (deg(e.a) === 1 || deg(e.b) === 1)) {
        dead[i] = 1;
        changed = true;
      }
    });
  }
  edges = edges.filter((_, i) => !dead[i]);
  adj = nodes.map(() => []);
  edges.forEach((e, i) => {
    adj[e.a]!.push(i);
    adj[e.b]!.push(i);
  });
  return { nodes, edges, adj, roads };
}

/** Nearest point on any edge, or `null` for an empty graph. */
export function snap(g: RoadGraph, x: number, z: number): SnapResult | null {
  let best: SnapResult | null = null;
  let bd = Infinity;
  for (let i = 0; i < g.edges.length; i++) {
    const e = g.edges[i]!, A = g.nodes[e.a]!, B = g.nodes[e.b]!;
    const dx = B.x - A.x, dz = B.z - A.z, L2 = dx * dx + dz * dz || 1;
    const t = clamp(((x - A.x) * dx + (z - A.z) * dz) / L2, 0, 1);
    const px = A.x + dx * t, pz = A.z + dz * t;
    const d = (px - x) * (px - x) + (pz - z) * (pz - z);
    if (d < bd) {
      bd = d;
      best = { x: px, z: pz, e: i, t, dist: 0 };
    }
  }
  if (best) best.dist = Math.sqrt(bd);
  return best;
}

/** Binary min-heap of `[priority, value]`. */
class MinHeap {
  private h: [number, number][] = [];
  get size(): number { return this.h.length; }
  push(d: number, n: number): void {
    const h = this.h;
    h.push([d, n]);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p]![0] <= h[i]![0]) break;
      [h[p], h[i]] = [h[i]!, h[p]!];
      i = p;
    }
  }
  pop(): [number, number] {
    const h = this.h;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && h[l]![0] < h[m]![0]) m = l;
        if (r < h.length && h[r]![0] < h[m]![0]) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i]!, h[m]!];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Shortest path along the network between two snapped points. Returns the
 * polyline (start, graph nodes, end). A single point is returned when the
 * end is unreachable.
 */
export function route(g: RoadGraph, s: SnapResult, e: SnapResult): { x: number; z: number }[] {
  if (s.e === e.e) return [{ x: s.x, z: s.z }, { x: e.x, z: e.z }];
  const N = g.nodes.length;
  const dist = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const done = new Uint8Array(N);
  const heap = new MinHeap();
  const es = g.edges[s.e]!, ee = g.edges[e.e]!;
  for (const n of [es.a, es.b]) {
    const p = g.nodes[n]!;
    dist[n] = Math.min(dist[n]!, Math.hypot(p.x - s.x, p.z - s.z));
    heap.push(dist[n]!, n);
  }
  while (heap.size) {
    const [d, u] = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    for (const ei of g.adj[u]!) {
      const ed = g.edges[ei]!, v = ed.a === u ? ed.b : ed.a, nd = d + ed.len;
      if (nd < dist[v]!) {
        dist[v] = nd;
        prev[v] = u;
        heap.push(nd, v);
      }
    }
  }
  let endNode = -1, bestT = Infinity;
  for (const n of [ee.a, ee.b]) {
    const p = g.nodes[n]!, t = dist[n]! + Math.hypot(p.x - e.x, p.z - e.z);
    if (t < bestT) { bestT = t; endNode = n; }
  }
  if (endNode < 0 || !Number.isFinite(bestT)) return [{ x: s.x, z: s.z }];
  const chain: number[] = [];
  for (let u = endNode; u >= 0; u = prev[u]!) chain.unshift(u);
  const pts = [{ x: s.x, z: s.z }, ...chain.map((u) => ({ x: g.nodes[u]!.x, z: g.nodes[u]!.z })), { x: e.x, z: e.z }];
  return pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1]!.x, p.z - pts[i - 1]!.z) > 0.01);
}

/** Length of a polyline. */
export function polylineLength(pts: readonly { x: number; z: number }[]): number {
  let d = 0;
  for (let i = 0; i < pts.length - 1; i++) d += Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.z - pts[i]!.z);
  return d;
}

/** Number of connected components among nodes that have at least one edge. */
export function connectedComponents(g: RoadGraph): number {
  const seen = new Uint8Array(g.nodes.length);
  let count = 0;
  for (let i = 0; i < g.nodes.length; i++) {
    if (seen[i] || !g.adj[i]!.length) continue;
    count++;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const u = stack.pop()!;
      for (const ei of g.adj[u]!) {
        const ed = g.edges[ei]!, v = ed.a === u ? ed.b : ed.a;
        if (!seen[v]) { seen[v] = 1; stack.push(v); }
      }
    }
  }
  return count;
}
