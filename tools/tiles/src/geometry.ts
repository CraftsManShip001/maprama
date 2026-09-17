/**
 * Tile-local geometry: clipping, footprint anchors, ring areas, and the
 * "synthetic edge" test that keeps the engine from building a riverbank down the
 * middle of the Han.
 *
 * All clipping happens **after** quantisation to tile-local integers, so a cut
 * lands on an exact integer line that both neighbouring tiles agree on. That is
 * what makes the seams line up, and it is also what makes the synthetic-edge
 * test a plain integer comparison.
 *
 * @module
 */

import { boundsOf, METERS_PER_DEGREE_LAT, METERS_PER_DEGREE_LNG, type LngLat } from './mercator.js';

/** A tile-local integer point. */
export type Pt = [number, number];

/** The square geometry is clipped to: `[-buffer, extent + buffer]` on both axes. */
export interface ClipRect {
  min: number;
  max: number;
}

/** The clip square for a tile of `extent` units with `buffer` units of margin. */
export function clipRect(extent: number, buffer: number): ClipRect {
  return { min: -buffer, max: extent + buffer };
}

/**
 * True when an edge of a clipped polygon was created by the clip rather than by
 * the data — both endpoints sit on the *same* side of the clip square.
 *
 * This is the rule `design/tile-format.md` §3.2 asks the renderer to apply
 * before deriving `banks` / `waterRibbons` from a water polygon: a tile-boundary
 * edge is where the river continues, not where its bank is, and putting a wall
 * there puts a wall across the river.
 *
 * Note the boundary values. §3.2 words the rule as "both endpoints on the tile
 * boundary (0 or `extent`)", but geometry is clipped to the tile **plus the
 * buffer**, so the edges the clip actually creates lie on `-buffer` and
 * `extent + buffer`. Testing 0 / `extent` finds none of them. This function
 * takes both numbers and tests the real clip square; {@link syntheticEdgeCount}
 * is used by the verifier to show the difference on a real Han-river tile.
 */
export function isSyntheticEdge(a: Pt, b: Pt, extent: number, buffer: number): boolean {
  const r = clipRect(extent, buffer);
  if (a[0] === b[0] && (a[0] === r.min || a[0] === r.max)) return true;
  if (a[1] === b[1] && (a[1] === r.min || a[1] === r.max)) return true;
  return false;
}

/** How many edges of a closed ring are synthetic under {@link isSyntheticEdge}. */
export function syntheticEdgeCount(ring: readonly Pt[], extent: number, buffer: number): number {
  let n = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if (isSyntheticEdge(ring[j]!, ring[i]!, extent, buffer)) n++;
  }
  return n;
}

/* ------------------------------------------------------------------ clipping */

function inside(p: Pt, edge: number, r: ClipRect): boolean {
  return edge === 0 ? p[0] >= r.min : edge === 1 ? p[0] <= r.max : edge === 2 ? p[1] >= r.min : p[1] <= r.max;
}

function intersect(a: Pt, b: Pt, edge: number, r: ClipRect): Pt {
  const value = edge === 0 || edge === 2 ? r.min : r.max;
  if (edge < 2) {
    const t = (value - a[0]) / (b[0] - a[0]);
    return [value, Math.round(a[1] + t * (b[1] - a[1]))];
  }
  const t = (value - a[1]) / (b[1] - a[1]);
  return [Math.round(a[0] + t * (b[0] - a[0])), value];
}

/**
 * Sutherland–Hodgman against the clip square.
 *
 * Intersections are rounded back to integers, so every vertex of the result is
 * an integer and the edges the clip creates lie exactly on the square — which is
 * what {@link isSyntheticEdge} relies on.
 */
export function clipPolygon(ring: readonly Pt[], r: ClipRect): Pt[] | null {
  let out: Pt[] = ring as Pt[];
  for (let edge = 0; edge < 4 && out.length > 0; edge++) {
    const input = out;
    out = [];
    for (let i = 0, j = input.length - 1; i < input.length; j = i++) {
      const cur = input[i]!;
      const prev = input[j]!;
      const curIn = inside(cur, edge, r);
      const prevIn = inside(prev, edge, r);
      if (curIn) {
        if (!prevIn) out.push(intersect(prev, cur, edge, r));
        out.push(cur);
      } else if (prevIn) {
        out.push(intersect(prev, cur, edge, r));
      }
    }
  }
  const cleaned = dedupe(out);
  if (cleaned.length > 1) {
    const f = cleaned[0]!;
    const l = cleaned[cleaned.length - 1]!;
    if (f[0] === l[0] && f[1] === l[1]) cleaned.pop();
  }
  return cleaned.length >= 3 ? cleaned : null;
}

function clipSegment(a: Pt, b: Pt, r: ClipRect): [Pt, Pt] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const tests: [number, number][] = [
    [-dx, a[0] - r.min],
    [dx, r.max - a[0]],
    [-dy, a[1] - r.min],
    [dy, r.max - a[1]],
  ];
  for (const [p, q] of tests) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  const at: Pt = [Math.round(a[0] + t0 * dx), Math.round(a[1] + t0 * dy)];
  const bt: Pt = [Math.round(a[0] + t1 * dx), Math.round(a[1] + t1 * dy)];
  return at[0] === bt[0] && at[1] === bt[1] ? null : [at, bt];
}

/** Liang–Barsky per segment; the polyline parts that survive, in order. */
export function clipPolyline(pts: readonly Pt[], r: ClipRect): Pt[][] {
  const parts: Pt[][] = [];
  let cur: Pt[] | null = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const seg = clipSegment(pts[i]!, pts[i + 1]!, r);
    if (!seg) {
      cur = null;
      continue;
    }
    const [a, b] = seg;
    const tail = cur?.[cur.length - 1];
    if (cur && tail && tail[0] === a[0] && tail[1] === a[1]) {
      cur.push(b);
    } else {
      cur = [a, b];
      parts.push(cur);
    }
  }
  return parts.filter((p) => p.length >= 2);
}

/** Removes vertices that repeat after quantisation. */
export function dedupe(pts: readonly Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

/* -------------------------------------------------------------- anchors, area */

/**
 * Anchor point of a footprint: its area-weighted centroid, falling back to the
 * bounding-box centre when the ring is degenerate.
 *
 * The fallback matters. A thin sliver's shoelace area is tiny but non-zero, and
 * dividing by it throws the anchor hundreds of metres away — which would file
 * the building under a tile it is nowhere near, and the whole no-seam guarantee
 * of §3.1 rests on the anchor being inside the footprint's own neighbourhood.
 */
export function ringAnchor(ring: readonly LngLat[]): LngLat {
  const b = boundsOf(ring);
  const mid: LngLat = [(b.west + b.east) / 2, (b.south + b.north) / 2];
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const px = ring[j]![0] - mid[0];
    const py = ring[j]![1] - mid[1];
    const qx = ring[i]![0] - mid[0];
    const qy = ring[i]![1] - mid[1];
    const cross = px * qy - qx * py;
    a += cross;
    cx += (px + qx) * cross;
    cy += (py + qy) * cross;
  }
  const bboxArea = (b.east - b.west) * (b.north - b.south);
  if (bboxArea <= 0 || Math.abs(a / 2) < 0.02 * bboxArea) return mid;
  const c: LngLat = [mid[0] + cx / (3 * a), mid[1] + cy / (3 * a)];
  const inBox = c[0] >= b.west && c[0] <= b.east && c[1] >= b.south && c[1] <= b.north;
  return inBox ? c : mid;
}

/** Ground area of a lng/lat ring, m² (equirectangular — exact enough at this scale). */
export function ringAreaM2(ring: readonly LngLat[]): number {
  const b = boundsOf(ring);
  const midLat = (b.north + b.south) / 2;
  const kx = METERS_PER_DEGREE_LNG * Math.cos((midLat * Math.PI) / 180);
  const ky = METERS_PER_DEGREE_LAT;
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j]![0] * kx * (ring[i]![1] * ky) - ring[i]![0] * kx * (ring[j]![1] * ky);
  }
  return Math.abs(a / 2);
}
