/**
 * Geometry helpers: flat ground quads/discs/polygons (prototype `quadsGeo`,
 * `discsGeo`, `polyGeo`, `flatGeo`), merged box lists and ribbons.
 *
 * @module
 */

import { BoxGeometry, BufferAttribute, BufferGeometry, Shape, ShapeGeometry } from 'three';
import type { Vec2 } from '@maprama/protocol';

/** `[ax, az, bx, bz, width]` */
export type Quad = [number, number, number, number, number];
/** `[x, z, radius]` */
export type Disc = [number, number, number];

/** Non-indexed flat (normal +y) geometry from triangle positions; uv = world x/z. */
export function flatGeo(pos: number[]): BufferGeometry {
  const g = new BufferGeometry();
  const p = new Float32Array(pos), n = new Float32Array(p.length), uv = new Float32Array((p.length / 3) * 2);
  for (let i = 0, k = 0; i < p.length; i += 3, k += 2) {
    n[i + 1] = 1;
    uv[k] = p[i]!;
    uv[k + 1] = p[i + 2]!;
  }
  g.setAttribute('position', new BufferAttribute(p, 3));
  g.setAttribute('normal', new BufferAttribute(n, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  return g;
}

/** Oriented flat quads (road strips, markings). */
export function quadsGeo(quads: readonly Quad[], y: number): BufferGeometry {
  const pos: number[] = [];
  for (const [ax, az, bx, bz, w] of quads) {
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1, nx = (-dz / L) * (w / 2), nz = (dx / L) * (w / 2);
    pos.push(ax + nx, y, az + nz, bx - nx, y, bz - nz, ax - nx, y, az - nz, ax + nx, y, az + nz, bx + nx, y, bz + nz, bx - nx, y, bz - nz);
  }
  return flatGeo(pos);
}

/** Flat discs (road node caps). */
export function discsGeo(discs: readonly Disc[], y: number, seg = 18): BufferGeometry {
  const pos: number[] = [];
  for (const [x, z, r] of discs) for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    pos.push(x, y, z, x + Math.cos(a1) * r, y, z + Math.sin(a1) * r, x + Math.cos(a0) * r, y, z + Math.sin(a0) * r);
  }
  return flatGeo(pos);
}

/** Flat polygon at height y (triangulated, +y normal). */
export function polyGeo(poly: readonly Vec2[], y: number): BufferGeometry {
  const sh = new Shape();
  poly.forEach(([x, z], i) => (i ? sh.lineTo(x, -z) : sh.moveTo(x, -z)));
  return new ShapeGeometry(sh).rotateX(-Math.PI / 2).translate(0, y, 0);
}

/** Ribbon (polyline with width) as quads plus round joints. */
export function ribbonGeo(pts: readonly Vec2[], width: number, y: number, joints = true): BufferGeometry {
  const quads: Quad[] = [];
  for (let i = 0; i < pts.length - 1; i++) quads.push([pts[i]![0], pts[i]![1], pts[i + 1]![0], pts[i + 1]![1], width]);
  if (!joints) return quadsGeo(quads, y);
  const discs: Disc[] = pts.map((p) => [p[0], p[1], width / 2]);
  return mergeFlat([quadsGeo(quads, y), discsGeo(discs, y)]);
}

/** Concatenates non-indexed geometries with position/normal/uv. Disposes the inputs. */
export function mergeFlat(geos: BufferGeometry[]): BufferGeometry {
  const names = ['position', 'normal', 'uv'] as const;
  const out = new BufferGeometry();
  for (const name of names) {
    const arrs = geos.map((g) => {
      const src = g.index ? g.toNonIndexed() : g;
      const a = src.getAttribute(name);
      const arr = a ? (a.array as Float32Array) : new Float32Array(0);
      if (src !== g) src.dispose();
      return arr;
    });
    const total = arrs.reduce((s, a) => s + a.length, 0);
    const buf = new Float32Array(total);
    let o = 0;
    for (const a of arrs) { buf.set(a, o); o += a.length; }
    out.setAttribute(name, new BufferAttribute(buf, name === 'uv' ? 2 : 3));
  }
  for (const g of geos) g.dispose();
  return out;
}

/** `[w, h, d, x, y, z, yaw?]` */
export type BoxSpec = [number, number, number, number, number, number, number?];

/** Merged boxes (optionally rotated around y about their own center). */
export function mergeBoxes(list: readonly BoxSpec[]): BufferGeometry {
  const geos = list.map(([w, h, d, x, y, z, yaw]) => {
    const g = new BoxGeometry(w, h, d).toNonIndexed();
    if (yaw) g.rotateY(yaw);
    g.translate(x, y, z);
    return g;
  });
  return mergeFlat(geos);
}
