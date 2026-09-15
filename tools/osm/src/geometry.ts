/**
 * Planar geometry helpers on `[x, z]` world-unit vertices.
 *
 * Winding convention: a ring is "counter-clockwise" when its shoelace signed
 * area, computed over `[x, z]` exactly as stored, is positive. This matches the
 * `@maprama/protocol` test fixtures (e.g. `[[1,1],[5,1],[5,5],[1,5]]`).
 *
 * @module
 */

import type { Vec2 } from '@maprama/protocol';

/** Axis-aligned rectangle in world units. */
export interface Rect {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** Shoelace signed area; positive = counter-clockwise (see module docs). */
export function signedArea(ring: readonly Vec2[]): number {
  let sum = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

/** Absolute polygon area. */
export function ringArea(ring: readonly Vec2[]): number {
  return Math.abs(signedArea(ring));
}

/** Returns the ring with counter-clockwise winding (a new array when reversed). */
export function ensureCCW(ring: Vec2[]): Vec2[] {
  return signedArea(ring) < 0 ? ring.slice().reverse() : ring;
}

/** True when both points are within `eps` of each other on both axes. */
export function samePoint(a: Vec2, b: Vec2, eps = 1e-9): boolean {
  return Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;
}

/** Removes a closing vertex equal to the first one. */
export function openRing(ring: Vec2[]): Vec2[] {
  if (ring.length > 1 && samePoint(ring[0]!, ring[ring.length - 1]!)) return ring.slice(0, -1);
  return ring;
}

/** Removes consecutive duplicate vertices (cyclically when `closed`). */
export function dedupeConsecutive(pts: Vec2[], closed: boolean, eps = 1e-9): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    if (out.length === 0 || !samePoint(out[out.length - 1]!, p, eps)) out.push(p);
  }
  if (closed) {
    while (out.length > 1 && samePoint(out[0]!, out[out.length - 1]!, eps)) out.pop();
  }
  return out;
}

/** Removes vertices lying on the straight line through their neighbours (ring). */
export function removeCollinear(ring: Vec2[], eps = 1e-9): Vec2[] {
  let pts = ring;
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    const out: Vec2[] = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[(i - 1 + n) % n]!;
      const b = pts[i]!;
      const c = pts[(i + 1) % n]!;
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(cross) <= eps) {
        changed = true;
        continue;
      }
      out.push(b);
    }
    if (out.length < 3) break;
    pts = out;
  }
  return pts;
}

function perpendicularDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz));
}

/** Douglas–Peucker polyline simplification (endpoints are kept). */
export function simplifyLine(pts: Vec2[], tolerance: number): Vec2[] {
  if (tolerance <= 0 || pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let maxDist = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicularDistance(pts[i]!, pts[first]!, pts[last]!);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index !== -1 && maxDist > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return pts.filter((_, i) => keep[i] === 1);
}

/** Douglas–Peucker simplification of an open ring (not closed). */
export function simplifyRing(ring: Vec2[], tolerance: number): Vec2[] {
  if (tolerance <= 0 || ring.length <= 4) return ring.slice();
  const p0 = ring[0]!;
  let far = 0;
  let farDist = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = Math.hypot(ring[i]![0] - p0[0], ring[i]![1] - p0[1]);
    if (d > farDist) {
      farDist = d;
      far = i;
    }
  }
  const a = simplifyLine(ring.slice(0, far + 1), tolerance);
  const b = simplifyLine([...ring.slice(far), p0], tolerance);
  const out = [...a.slice(0, -1), ...b.slice(0, -1)];
  // Never simplify a valid polygon below a triangle.
  return out.length >= 3 ? out : ring.slice();
}

/** Sutherland–Hodgman clip of a ring against an axis-aligned rectangle. */
export function clipRingToRect(ring: Vec2[], rect: Rect): Vec2[] {
  type Edge = { inside: (p: Vec2) => boolean; cut: (a: Vec2, b: Vec2) => Vec2 };
  const lerpX = (a: Vec2, b: Vec2, x: number): Vec2 => [x, a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0])];
  const lerpZ = (a: Vec2, b: Vec2, z: number): Vec2 => [a[0] + ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]), z];
  const edges: Edge[] = [
    { inside: (p) => p[0] >= rect.minX, cut: (a, b) => lerpX(a, b, rect.minX) },
    { inside: (p) => p[0] <= rect.maxX, cut: (a, b) => lerpX(a, b, rect.maxX) },
    { inside: (p) => p[1] >= rect.minZ, cut: (a, b) => lerpZ(a, b, rect.minZ) },
    { inside: (p) => p[1] <= rect.maxZ, cut: (a, b) => lerpZ(a, b, rect.maxZ) },
  ];
  let output = ring;
  for (const edge of edges) {
    const input = output;
    output = [];
    const n = input.length;
    if (n === 0) break;
    for (let i = 0; i < n; i++) {
      const cur = input[i]!;
      const prev = input[(i - 1 + n) % n]!;
      const curIn = edge.inside(cur);
      const prevIn = edge.inside(prev);
      if (curIn) {
        if (!prevIn) output.push(edge.cut(prev, cur));
        output.push(cur);
      } else if (prevIn) {
        output.push(edge.cut(prev, cur));
      }
    }
  }
  return output;
}

/** Liang–Barsky clip of a polyline against a rectangle; returns the inside pieces. */
export function clipPolylineToRect(pts: Vec2[], rect: Rect): Vec2[][] {
  const pieces: Vec2[][] = [];
  let current: Vec2[] = [];
  const flush = (): void => {
    if (current.length >= 2) pieces.push(current);
    current = [];
  };
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    let t0 = 0;
    let t1 = 1;
    const p = [-dx, dx, -dz, dz];
    const q = [a[0] - rect.minX, rect.maxX - a[0], a[1] - rect.minZ, rect.maxZ - a[1]];
    let visible = true;
    for (let k = 0; k < 4; k++) {
      const pk = p[k]!;
      const qk = q[k]!;
      if (pk === 0) {
        if (qk < 0) {
          visible = false;
          break;
        }
      } else {
        const r = qk / pk;
        if (pk < 0) {
          if (r > t1) {
            visible = false;
            break;
          }
          if (r > t0) t0 = r;
        } else {
          if (r < t0) {
            visible = false;
            break;
          }
          if (r < t1) t1 = r;
        }
      }
    }
    if (!visible) {
      flush();
      continue;
    }
    const start: Vec2 = t0 === 0 ? a : [a[0] + t0 * dx, a[1] + t0 * dz];
    const end: Vec2 = t1 === 1 ? b : [a[0] + t1 * dx, a[1] + t1 * dz];
    if (current.length === 0 || !samePoint(current[current.length - 1]!, start)) {
      flush();
      current.push(start);
    }
    current.push(end);
    if (t1 < 1) flush();
  }
  flush();
  return pieces;
}

/** Area-weighted centroid (falls back to the vertex mean for degenerate rings). */
export function ringCentroid(ring: readonly Vec2[]): Vec2 {
  let a = 0;
  let cx = 0;
  let cz = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % n]!;
    const cross = p[0] * q[1] - q[0] * p[1];
    a += cross;
    cx += (p[0] + q[0]) * cross;
    cz += (p[1] + q[1]) * cross;
  }
  if (Math.abs(a) < 1e-12) {
    let sx = 0;
    let sz = 0;
    for (const p of ring) {
      sx += p[0];
      sz += p[1];
    }
    return [sx / Math.max(1, n), sz / Math.max(1, n)];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

/** Even–odd ray-casting point-in-polygon test. */
export function pointInRing(p: Vec2, ring: readonly Vec2[]): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * A point guaranteed (for non-degenerate rings) to lie inside the polygon: the
 * centroid when it is inside, otherwise the middle of the widest horizontal
 * span through the centroid's z.
 */
export function interiorPoint(ring: readonly Vec2[]): Vec2 {
  const c = ringCentroid(ring);
  if (pointInRing(c, ring)) return c;
  const z = c[1];
  const xs: number[] = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    if (a[1] > z !== b[1] > z) xs.push(a[0] + ((z - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
  }
  xs.sort((p, q) => p - q);
  let best: Vec2 = c;
  let width = -1;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    const w = xs[i + 1]! - xs[i]!;
    if (w > width) {
      width = w;
      best = [(xs[i]! + xs[i + 1]!) / 2, z];
    }
  }
  return best;
}

/** Bounding rectangle of a set of points. */
export function pointsRect(pts: readonly Vec2[]): Rect {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1];
    if (p[1] > maxZ) maxZ = p[1];
  }
  return { minX, minZ, maxX, maxZ };
}

/** True when two rectangles overlap (touching counts). */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minZ <= b.maxZ && b.minZ <= a.maxZ;
}

/** True when the point lies inside or on the rectangle. */
export function pointInRect(p: { x: number; z: number }, r: Rect): boolean {
  return p.x >= r.minX && p.x <= r.maxX && p.z >= r.minZ && p.z <= r.maxZ;
}

/** Rounds a number to `decimals` decimal places (avoids `-0`). */
export function roundTo(v: number, decimals: number): number {
  const f = 10 ** decimals;
  const r = Math.round(v * f) / f;
  return r === 0 ? 0 : r;
}

/**
 * Joins open way segments (arrays of points keyed by exact coordinates) into
 * closed rings. Segments that cannot be closed are dropped. Returned rings are
 * open (the closing vertex is removed).
 */
export function assembleRings<T>(segments: T[][], key: (p: T) => string): T[][] {
  const pending = segments.filter((s) => s.length >= 2).map((s) => s.slice());
  const rings: T[][] = [];
  while (pending.length > 0) {
    let current = pending.shift()!;
    let guard = 0;
    while (key(current[0]!) !== key(current[current.length - 1]!) && guard++ < 100000) {
      const tail = key(current[current.length - 1]!);
      const head = key(current[0]!);
      const idx = pending.findIndex((s) => {
        const f = key(s[0]!);
        const l = key(s[s.length - 1]!);
        return f === tail || l === tail || f === head || l === head;
      });
      if (idx === -1) break;
      const seg = pending.splice(idx, 1)[0]!;
      const f = key(seg[0]!);
      const l = key(seg[seg.length - 1]!);
      if (f === tail) current = current.concat(seg.slice(1));
      else if (l === tail) current = current.concat(seg.slice(0, -1).reverse());
      else if (l === head) current = seg.slice(0, -1).concat(current);
      else current = seg.slice(1).reverse().concat(current);
    }
    if (current.length >= 4 && key(current[0]!) === key(current[current.length - 1]!)) {
      rings.push(current.slice(0, -1));
    }
  }
  return rings;
}
