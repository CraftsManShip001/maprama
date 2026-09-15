/**
 * 2D polygon helpers on `[x, z]` world-unit rings (pure; testable in node).
 *
 * @module
 */

import type { Vec2 } from '@maprama/protocol';

/** Signed area (shoelace) in the x/z plane. Positive = counter-clockwise when +x right, +z down... see {@link isClockwiseXZ}. */
export function signedArea(poly: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const p = poly[i]!, q = poly[j]!;
    a += q[0] * p[1] - p[0] * q[1];
  }
  return a / 2;
}

/**
 * Returns the ring ordered so that walking the edges keeps the interior on
 * the left in (x, z) math orientation (positive shoelace area). Outward edge
 * normals of such a ring are `(dz, -dx)` for an edge direction `(dx, dz)`.
 */
export function normalizeRing(poly: readonly Vec2[]): Vec2[] {
  const out = dedupeRing(poly);
  return signedArea(out) < 0 ? out.reverse() : out;
}

/** Removes consecutive duplicate vertices and a closing duplicate. */
export function dedupeRing(poly: readonly Vec2[], eps = 1e-6): Vec2[] {
  const out: Vec2[] = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > eps || Math.abs(last[1] - p[1]) > eps) out.push([p[0], p[1]]);
  }
  if (out.length > 1) {
    const a = out[0]!, b = out[out.length - 1]!;
    if (Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps) out.pop();
  }
  return out;
}

export function centroid(poly: readonly Vec2[]): { x: number; z: number } {
  const a = signedArea(poly);
  if (Math.abs(a) < 1e-9) {
    let x = 0, z = 0;
    for (const p of poly) { x += p[0]; z += p[1]; }
    return { x: x / Math.max(1, poly.length), z: z / Math.max(1, poly.length) };
  }
  let cx = 0, cz = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const p = poly[i]!, q = poly[j]!;
    const f = q[0] * p[1] - p[0] * q[1];
    cx += (q[0] + p[0]) * f;
    cz += (q[1] + p[1]) * f;
  }
  return { x: cx / (6 * a), z: cz / (6 * a) };
}

/** Even-odd point in polygon test. */
export function pointInPolygon(x: number, z: number, poly: readonly Vec2[]): boolean {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!;
    const [xj, zj] = poly[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) ins = !ins;
  }
  return ins;
}

export function perimeter(poly: readonly Vec2[]): number {
  let L = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    L += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return L;
}

export function bbox(poly: readonly Vec2[]): { minX: number; minZ: number; maxX: number; maxZ: number } {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of poly) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minZ, maxX, maxZ };
}

/**
 * Offsets a normalized ring (see {@link normalizeRing}) by `d` world units
 * (positive = outward) using mitered corners; miters are clamped to `4·|d|`
 * so sharp corners do not spike.
 */
export function offsetRing(ring: readonly Vec2[], d: number): Vec2[] {
  const n = ring.length;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const p = ring[(i + n - 1) % n]!, c = ring[i]!, q = ring[(i + 1) % n]!;
    let ax = c[0] - p[0], az = c[1] - p[1];
    let bx = q[0] - c[0], bz = q[1] - c[1];
    const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
    ax /= la; az /= la; bx /= lb; bz /= lb;
    // outward normals for positive-area rings: (dz, -dx)
    const n1x = az, n1z = -ax, n2x = bz, n2z = -bx;
    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { mx = n1x; mz = n1z; } else { mx /= ml; mz /= ml; }
    const cos = mx * n1x + mz * n1z;
    let k = d / Math.max(cos, 1e-3);
    const lim = 4 * Math.abs(d);
    if (Math.abs(k) > lim) k = Math.sign(k) * lim;
    out.push([c[0] + mx * k, c[1] + mz * k]);
  }
  return out;
}

/** Scales a ring about a point. */
export function scaleRing(ring: readonly Vec2[], cx: number, cz: number, s: number): Vec2[] {
  return ring.map(([x, z]) => [cx + (x - cx) * s, cz + (z - cz) * s] as Vec2);
}

/** Corners of an oriented rectangle (center, yaw in radians like `Object3D.rotation.y`, width along local x, depth along local z). */
export function rectCorners(cx: number, cz: number, yaw: number, w: number, d: number): Vec2[] {
  // Object3D rotation.y maps local (u, v) → world (u·cos + v·sin, −u·sin + v·cos)
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const pts: Vec2[] = [];
  for (const [u, v] of [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]] as const) {
    pts.push([cx + u * c + v * s, cz - u * s + v * c]);
  }
  return normalizeRing(pts);
}

/** Separating-axis overlap test for two convex rings; `tol` shrinks the overlap (touching counts as not overlapping). */
export function convexOverlap(a: readonly Vec2[], b: readonly Vec2[], tol = 1e-3): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
      const nx = q[1] - p[1], nz = p[0] - q[0];
      const len = Math.hypot(nx, nz) || 1;
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const v of a) { const t = (v[0] * nx + v[1] * nz) / len; minA = Math.min(minA, t); maxA = Math.max(maxA, t); }
      for (const v of b) { const t = (v[0] * nx + v[1] * nz) / len; minB = Math.min(minB, t); maxB = Math.max(maxB, t); }
      if (maxA - tol <= minB || maxB - tol <= minA) return false;
    }
  }
  return true;
}

/**
 * Detects near-rectangular 4-vertex rings. Returns the equivalent oriented
 * rectangle (yaw aligned with the longest edge) or `null`.
 */
export function asRectangle(ring: readonly Vec2[], angleTolDeg = 6): { x: number; z: number; w: number; d: number; yaw: number } | null {
  if (ring.length !== 4) return null;
  const cosTol = Math.sin((angleTolDeg * Math.PI) / 180);
  for (let i = 0; i < 4; i++) {
    const p = ring[(i + 3) % 4]!, c = ring[i]!, q = ring[(i + 1) % 4]!;
    const ax = c[0] - p[0], az = c[1] - p[1], bx = q[0] - c[0], bz = q[1] - c[1];
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < 1e-6 || lb < 1e-6) return null;
    if (Math.abs((ax * bx + az * bz) / (la * lb)) > cosTol) return null;
  }
  const p0 = ring[0]!, p1 = ring[1]!, p3 = ring[3]!;
  const e1 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const e2 = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
  const c = centroid(ring);
  // local +x along edge p0→p1; world dir (cos, −sin) ⇒ yaw = atan2(−dz, dx)
  const yaw = Math.atan2(-(p1[1] - p0[1]), p1[0] - p0[0]);
  return { x: c.x, z: c.z, w: e1, d: e2, yaw };
}
