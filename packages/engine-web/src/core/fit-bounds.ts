/**
 * `fitBounds` geometry: the camera orbit that frames a set of ground points
 * inside a padded rectangle of the viewport.
 *
 * Pure math — no three.js, no DOM — because the native core ports it verbatim
 * (`CameraMath.cpp`) and the conformance fixtures compare the two step for
 * step. The projection below is exactly what three's `PerspectiveCamera` +
 * `lookAt` produce for a {@link CameraOrbit} (asserted in `fit-bounds.test.ts`
 * against a real {@link CameraController}).
 *
 * Why it iterates: at a pitch above 0 the ground is a trapezoid on screen, so
 * there is no closed form for "the distance at which this box just fits". One
 * step scales the distance by how much the box over/undershoots the rectangle,
 * the next re-centres the target under the rectangle's middle; the pair
 * converges in a handful of rounds because screen size is very nearly `1 / d`.
 *
 * @module
 */

import type { WorldPoint } from '@maprama/protocol';
import { clamp, DEG } from '../util/math.js';

/**
 * Rounds of scale + re-centre. The scale step is exact at pitch 0 and within a
 * few percent at pitch 60, so a handful of rounds settle any box; 24 leaves a
 * wide margin and costs four point projections each.
 */
export const FIT_ITERATIONS = 24;

/** How the current pitch / bearing are treated (protocol `FitBoundsOrientation`). */
export type FitOrientation = 'auto' | 'keep' | 'reset';

/** Padding kept free inside the viewport, in the same pixels as `width` / `height`. */
export interface FitPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface FitBoundsInput {
  /** Ground points to enclose (the four corners of the box), in world units. */
  corners: readonly WorldPoint[];
  /** Viewport size in CSS pixels / dp. */
  width: number;
  height: number;
  padding: FitPadding;
  /** Vertical field of view in degrees. */
  fovDeg: number;
  /** Pitch / bearing to frame at (degrees) — already resolved from the request and the current camera. */
  pitch: number;
  bearing: number;
  /** Distance limits in world units. */
  minDistance: number;
  maxDistance: number;
  /** Distance the search starts from (the current camera distance); only affects how fast it converges. */
  startDistance: number;
}

export interface FitBoundsOutput {
  x: number;
  z: number;
  distance: number;
  pitch: number;
  bearing: number;
  /** Every corner is inside the padded rectangle at this orbit. */
  fitted: boolean;
  /** The distance the geometry asked for was outside `[minDistance, maxDistance]`. */
  distanceLimited: boolean;
}

interface Basis {
  cx: number;
  cy: number;
  cz: number;
  /** Right, up and backward axes of the camera (three's `lookAt` frame). */
  rx: number; ry: number; rz: number;
  ux: number; uy: number; uz: number;
  bx: number; by: number; bz: number;
}

/** The camera frame for an orbit: position plus the three axes three's `lookAt` builds. */
function basisFor(x: number, z: number, distance: number, pitchDeg: number, bearingDeg: number): Basis {
  const p = pitchDeg * DEG, b = bearingDeg * DEG, h = distance * Math.sin(p);
  const cx = x - Math.sin(b) * h, cy = distance * Math.cos(p), cz = z + Math.cos(b) * h;
  // up vector of the orbit camera
  const upx = Math.sin(b), upy = 0, upz = -Math.cos(b);
  // z axis = normalize(eye - target)
  let zx = cx - x, zy = cy, zz = cz - z;
  const zl = Math.hypot(zx, zy, zz) || 1;
  zx /= zl; zy /= zl; zz /= zl;
  // x axis = normalize(up x z)
  let xx = upy * zz - upz * zy, xy = upz * zx - upx * zz, xz = upx * zy - upy * zx;
  const xl = Math.hypot(xx, xy, xz) || 1;
  xx /= xl; xy /= xl; xz /= xl;
  // y axis = z x x
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return { cx, cy, cz, rx: xx, ry: xy, rz: xz, ux: yx, uy: yy, uz: yz, bx: zx, by: zy, bz: zz };
}

/** Projects a world point to pixels. `visible` is false behind the camera (the pixel is then meaningless). */
function project(
  basis: Basis,
  px: number, py: number, pz: number,
  width: number, height: number, tanHalf: number,
): { x: number; y: number; ahead: boolean } {
  const vx = px - basis.cx, vy = py - basis.cy, vz = pz - basis.cz;
  const cxv = vx * basis.rx + vy * basis.ry + vz * basis.rz;
  const cyv = vx * basis.ux + vy * basis.uy + vz * basis.uz;
  const czv = vx * basis.bx + vy * basis.by + vz * basis.bz;
  const depth = -czv;
  if (!(depth > 1e-9)) return { x: 0, y: 0, ahead: false };
  const aspect = width / height;
  const ndcX = cxv / (aspect * tanHalf * depth), ndcY = cyv / (tanHalf * depth);
  return { x: (ndcX * 0.5 + 0.5) * width, y: (-ndcY * 0.5 + 0.5) * height, ahead: true };
}

/** Ground-plane (y = 0) point under a pixel, or `null` when the ray misses the ground. */
function groundAt(
  basis: Basis,
  px: number, py: number,
  width: number, height: number, tanHalf: number,
): WorldPoint | null {
  const aspect = width / height;
  const ndcX = (px / width) * 2 - 1, ndcY = -(py / height) * 2 + 1;
  const dcx = ndcX * aspect * tanHalf, dcy = ndcY * tanHalf, dcz = -1;
  const dx = basis.rx * dcx + basis.ux * dcy + basis.bx * dcz;
  const dy = basis.ry * dcx + basis.uy * dcy + basis.by * dcz;
  const dz = basis.rz * dcx + basis.uz * dcy + basis.bz * dcz;
  if (Math.abs(dy) < 1e-9) return null;
  const t = -basis.cy / dy;
  if (!(t > 0)) return null;
  return { x: basis.cx + dx * t, z: basis.cz + dz * t };
}

/**
 * The orbit that frames `corners` inside the padded rectangle.
 *
 * The result is always a usable camera: when the box cannot fit — the distance
 * it needs is beyond `maxDistance` — the camera goes to `maxDistance` centred
 * on the box and `fitted` is false, so the host can decide what to do.
 */
export function fitBoundsOrbit(input: FitBoundsInput): FitBoundsOutput {
  const { corners, width, height, padding, minDistance, maxDistance } = input;
  const tanHalf = Math.tan((input.fovDeg * DEG) / 2);
  const x0 = padding.left, y0 = padding.top;
  const rw = Math.max(1, width - padding.left - padding.right);
  const rh = Math.max(1, height - padding.top - padding.bottom);
  const rectCx = x0 + rw / 2, rectCy = y0 + rh / 2;

  let cx = 0, cz = 0;
  for (const c of corners) { cx += c.x; cz += c.z; }
  cx /= Math.max(1, corners.length);
  cz /= Math.max(1, corners.length);

  let d = clamp(input.startDistance, minDistance, maxDistance);
  let raw = d;
  for (let i = 0; i < FIT_ITERATIONS; i++) {
    const basis = basisFor(cx, cz, d, input.pitch, input.bearing);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, behind = false;
    for (const c of corners) {
      const s = project(basis, c.x, 0, c.z, width, height, tanHalf);
      if (!s.ahead) { behind = true; break; }
      if (s.x < minX) minX = s.x;
      if (s.x > maxX) maxX = s.x;
      if (s.y < minY) minY = s.y;
      if (s.y > maxY) maxY = s.y;
    }
    if (behind) {
      // A corner is behind the camera: nothing to measure, back off and try again.
      raw = d * 2;
      d = clamp(raw, minDistance, maxDistance);
      if (d === maxDistance && raw > maxDistance) break;
      continue;
    }
    const scale = Math.min(rw / Math.max(1e-6, maxX - minX), rh / Math.max(1e-6, maxY - minY));
    raw = d / scale;
    d = clamp(raw, minDistance, maxDistance);
    // Re-centre: put the ground point currently under the box's screen centre under the rectangle's.
    const moved = basisFor(cx, cz, d, input.pitch, input.bearing);
    const at = groundAt(moved, (minX + maxX) / 2, (minY + maxY) / 2, width, height, tanHalf);
    const want = groundAt(moved, rectCx, rectCy, width, height, tanHalf);
    if (at && want) {
      cx += at.x - want.x;
      cz += at.z - want.z;
    }
  }

  const fitted = enclosed(corners, cx, cz, d, input, tanHalf, x0, y0, rw, rh);
  return {
    x: cx,
    z: cz,
    distance: d,
    pitch: input.pitch,
    bearing: input.bearing,
    fitted,
    distanceLimited: raw < minDistance - 1e-9 || raw > maxDistance + 1e-9,
  };
}

/** Whether every corner lands inside the padded rectangle (half a pixel of slack). */
function enclosed(
  corners: readonly WorldPoint[],
  cx: number, cz: number, d: number,
  input: FitBoundsInput, tanHalf: number,
  x0: number, y0: number, rw: number, rh: number,
): boolean {
  const basis = basisFor(cx, cz, d, input.pitch, input.bearing);
  const eps = 0.5;
  for (const c of corners) {
    const s = project(basis, c.x, 0, c.z, input.width, input.height, tanHalf);
    if (!s.ahead) return false;
    if (s.x < x0 - eps || s.x > x0 + rw + eps || s.y < y0 - eps || s.y > y0 + rh + eps) return false;
  }
  return true;
}

/**
 * {@link fitBoundsOrbit} with the protocol's `orientation` rule: `auto` frames
 * at the current pitch / bearing and falls back to straight-down-to-north when
 * that is the only way the box fits.
 */
export function fitBounds(
  input: Omit<FitBoundsInput, 'pitch' | 'bearing'> & { pitch: number; bearing: number; orientation: FitOrientation },
): FitBoundsOutput {
  if (input.orientation === 'reset') return fitBoundsOrbit({ ...input, pitch: 0, bearing: 0 });
  const kept = fitBoundsOrbit(input);
  if (input.orientation === 'keep' || kept.fitted) return kept;
  const reset = fitBoundsOrbit({ ...input, pitch: 0, bearing: 0 });
  return reset.fitted ? reset : kept;
}
