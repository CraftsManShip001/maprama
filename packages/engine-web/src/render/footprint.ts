/**
 * Geometry for extruded footprints (arbitrary simple polygons): facade walls
 * with UVs running along each edge so textures tile per floor, flat caps,
 * slabs, ring bands (parapets, slab edges, cornices) and rounded soft masses.
 *
 * Rings must be normalized (positive shoelace area in x/z, see
 * `normalizeRing`); outward normals are then `(dz, -dx)`.
 *
 * @module
 */

import { BufferAttribute, BufferGeometry, ExtrudeGeometry, Shape, ShapeUtils, Vector2 } from 'three';
import type { Vec2 } from '@diorama/protocol';
import { signedArea } from '../world/polygon.js';

export interface WallUv {
  /** Tile width (world units). */
  U: number;
  /** Tile height (world units). */
  V: number;
  uOffset: number;
  vOffset: number;
  /** Added to the wall-relative height before dividing by V (prototype `m.y`). */
  vBase: number;
}

export interface ShadeColors {
  /** Vertex color multiplier at the wall bottom. */
  bottom: number;
}

class Builder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] | null;
  constructor(withColor: boolean) {
    this.col = withColor ? [] : null;
  }
  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, w: number, c = 1): void {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, w);
    this.col?.push(c, c, c);
  }
  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    if (this.col) g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    return g;
  }
}

function walls(b: Builder, ring: readonly Vec2[], y0: number, h: number, uv: WallUv | null, colors: ShadeColors | null, inward = false): void {
  const n = ring.length;
  const y1 = y0 + h;
  let dist = 0;
  const cb = colors ? colors.bottom : 1;
  for (let i = 0; i < n; i++) {
    const A = ring[i]!, B = ring[(i + 1) % n]!;
    const dx = B[0] - A[0], dz = B[1] - A[1], L = Math.hypot(dx, dz);
    if (L < 1e-6) continue;
    let nx = dz / L, nz = -dx / L;
    if (inward) { nx = -nx; nz = -nz; }
    const u0 = uv ? dist / uv.U + uv.uOffset : 0.03, u1 = uv ? (dist + L) / uv.U + uv.uOffset : 0.03;
    const v0 = uv ? uv.vBase / uv.V + uv.vOffset : 0.03, v1 = uv ? (h + uv.vBase) / uv.V + uv.vOffset : 0.03;
    // outward faces: (A0, B1, B0), (A0, A1, B1)
    const A0: [number, number, number, number, number] = [A[0], y0, A[1], u0, v0];
    const B0: [number, number, number, number, number] = [B[0], y0, B[1], u1, v0];
    const A1: [number, number, number, number, number] = [A[0], y1, A[1], u0, v1];
    const B1: [number, number, number, number, number] = [B[0], y1, B[1], u1, v1];
    const tris = inward ? [A0, B0, B1, A0, B1, A1] : [A0, B1, B0, A0, A1, B1];
    for (const p of tris) b.v(p[0], p[1], p[2], nx, 0, nz, p[3], p[4], p[1] === y0 ? cb : 1);
    dist += L;
  }
}

function cap(b: Builder, outer: readonly Vec2[], holes: readonly (readonly Vec2[])[], y: number, up: boolean, uvScale: number | null = null): void {
  const contour = outer.map((p) => new Vector2(p[0], p[1]));
  const holeV = holes.map((h) => h.map((p) => new Vector2(p[0], p[1])));
  const all = [...contour, ...holeV.flat()];
  let faces: number[][];
  try {
    faces = ShapeUtils.triangulateShape(contour, holeV);
  } catch {
    return;
  }
  const ny = up ? 1 : -1;
  for (const f of faces) {
    const a = all[f[0]!]!, bb = all[f[1]!]!, c = all[f[2]!]!;
    // y component of (b−a)×(c−a) in (x, y, z) with the 2D y as world z
    const cy = (bb.y - a.y) * (c.x - a.x) - (bb.x - a.x) * (c.y - a.y);
    const order = (cy > 0) === up ? [a, bb, c] : [a, c, bb];
    for (const p of order) b.v(p.x, y, p.y, 0, ny, 0, uvScale === null ? 0.03 : p.x * uvScale, uvScale === null ? 0.03 : p.y * uvScale);
  }
}

/** Facade walls of a prism (no caps). Adds a vertex `color` attribute when `colors` is given. */
export function wallsGeometry(ring: readonly Vec2[], y0: number, h: number, uv: WallUv | null, colors: ShadeColors | null = null): BufferGeometry {
  const b = new Builder(!!colors);
  walls(b, ring, y0, h, uv, colors);
  return b.build();
}

/**
 * Facade walls plus a flat top cap. The cap samples a flat texel unless
 * `capUvScale` is given (then cap uv = x/z · scale, for tiling roof textures).
 */
export function prismGeometry(ring: readonly Vec2[], y0: number, h: number, uv: WallUv | null = null, colors: ShadeColors | null = null, capUvScale: number | null = null): BufferGeometry {
  const b = new Builder(!!colors);
  walls(b, ring, y0, h, uv, colors);
  cap(b, ring, [], y0 + h, true, capUvScale);
  return b.build();
}

/** A closed band between an outer and inner ring (parapets, slab edges, cornices): walls both sides and top/bottom caps. */
export function ringBandGeometry(outer: readonly Vec2[], inner: readonly Vec2[], y0: number, h: number): BufferGeometry {
  const b = new Builder(false);
  walls(b, outer, y0, h, null, null);
  walls(b, inner, y0, h, null, null, true);
  cap(b, outer, [inner], y0 + h, true);
  if (h > 0.01) cap(b, outer, [inner], y0, false);
  return b.build();
}

/** Flat polygon cap only. */
export function capGeometry(ring: readonly Vec2[], y: number): BufferGeometry {
  const b = new Builder(false);
  cap(b, ring, [], y, true);
  return b.build();
}

/**
 * Rounded, bevelled extrusion for the `soft` preset: corners are rounded with
 * quadratic curves (radius ~22% of the shorter adjacent edge), the outline is
 * inset by the bevel so the result keeps the footprint size. Material groups:
 * 0 = caps, 1 = sides (like `ExtrudeGeometry`).
 */
export function softMassGeometry(ring: readonly Vec2[], y0: number, h: number, bevel: number, insetRing: readonly Vec2[]): BufferGeometry {
  const n = insetRing.length;
  const sh = new Shape();
  const lens = insetRing.map((p, i) => {
    const q = insetRing[(i + 1) % n]!;
    return Math.hypot(q[0] - p[0], q[1] - p[1]);
  });
  // shape space: (x, −z) so that rotateX(−π/2) maps back to world z
  const P = (p: Vec2): [number, number] => [p[0], -p[1]];
  for (let i = 0; i < n; i++) {
    const prev = insetRing[(i + n - 1) % n]!, cur = insetRing[i]!, next = insetRing[(i + 1) % n]!;
    const lp = lens[(i + n - 1) % n]!, ln = lens[i]!;
    const rr = Math.min(Math.max(0.06, Math.min(lp, ln) * 0.225), Math.min(lp, ln) * 0.45);
    const a: Vec2 = [cur[0] + ((prev[0] - cur[0]) / (lp || 1)) * rr, cur[1] + ((prev[1] - cur[1]) / (lp || 1)) * rr];
    const c: Vec2 = [cur[0] + ((next[0] - cur[0]) / (ln || 1)) * rr, cur[1] + ((next[1] - cur[1]) / (ln || 1)) * rr];
    const [ax, ay] = P(a), [bx, by] = P(cur), [cx, cy] = P(c);
    if (i === 0) sh.moveTo(ax, ay); else sh.lineTo(ax, ay);
    sh.quadraticCurveTo(bx, by, cx, cy);
  }
  sh.closePath();
  const geo = new ExtrudeGeometry(sh, {
    depth: Math.max(0.05, h - bevel * 2),
    bevelEnabled: bevel > 0.001,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 4,
    curveSegments: 6,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y0 + bevel, 0);
  void ring;
  return geo;
}

/** Largest distance from (x, z) to the ring boundary that stays inside (approximate inscribed radius). */
export function insideRadius(ring: readonly Vec2[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L2));
    best = Math.min(best, Math.hypot(a[0] + dx * t - x, a[1] + dz * t - z));
  }
  return Number.isFinite(best) ? best : 0;
}

/** True when the ring is wound as expected (positive area). */
export function isNormalized(ring: readonly Vec2[]): boolean {
  return signedArea(ring) > 0;
}
