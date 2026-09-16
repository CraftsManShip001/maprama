/**
 * Camera controller: orbit state (target, distance, pitch, bearing), limits,
 * animated transitions, follow target (for part 2 characters), "to north",
 * and screen ⇄ world projection. Uses three.js math only (no WebGL), so it
 * works in node tests.
 *
 * Conventions (match `@maprama/protocol` `CameraSpec`):
 * - `pitch` degrees, 0 = straight down, clamped to 0–60.
 * - `bearing` degrees clockwise from north = the compass direction at the top of the screen.
 * - `distance` world units here (the protocol uses meters; convert with `unitMeters`), clamped to
 *   the current distance limits (by default 14–150 world units, see {@link CameraController.setDistanceLimits}).
 *
 * Content inset (`ui.contentInset`): the renderer keeps drawing the whole
 * viewport, but the camera's target — `orbit.x` / `orbit.z`, the *anchor* — is
 * the ground point at the centre of the **visible area** (the viewport minus
 * the inset). {@link CameraController.apply} is the only place that knows the
 * difference: it looks at `anchor − insetShift()`. Everything else (gestures,
 * follow, zoom, `fitBounds`, the reported camera state) works on the anchor,
 * and screen coordinates stay full-view pixels.
 *
 * @module
 */

import { CAMERA_FOV_DEG, type CameraIdleReason, type ContentInset } from '@maprama/protocol';
import { PerspectiveCamera, Plane, Raycaster, Vector2, Vector3 } from 'three';
import { clamp, DEG, wrapDeg } from '../util/math.js';
import { basisFor, groundAt } from './fit-bounds.js';

export const PITCH_MIN = 0;
export const PITCH_MAX = 60;
/** Pitch the "to north" affordance settles at (clamped into the pitch limits in force). */
export const TO_NORTH_PITCH = 45;
/** Default closest camera distance, in world units (112 m at the default 8 m per unit). */
export const DIST_MIN = 14;
/** Default furthest camera distance, in world units (1,200 m at the default 8 m per unit). */
export const DIST_MAX = 150;

/**
 * Hard limits of the renderer, in world units. An app's `minDistanceMeters` /
 * `maxDistanceMeters` are clamped into this range.
 *
 * - below {@link DIST_HARD_MIN} the camera is inside the near plane of its own frustum and
 *   inside the buildings it looks at;
 * - above {@link DIST_HARD_MAX} the depth buffer of a `near … 6 · distance` frustum starts to
 *   z-fight on the road markings, and the fog ramp (below) has grown past any world we generate.
 *
 * 1,000 units is 8 km at the default 8 m per unit and 24 km at 24 m per unit.
 */
export const DIST_HARD_MIN = 2;
export const DIST_HARD_MAX = 1000;

/** Camera near plane, world units: 0.5 up to {@link DIST_MAX}, then `distance / 300` (a constant far:near ratio). */
export const NEAR_BASE = 0.5;
/** Camera far plane, world units: 900 up to {@link DIST_MAX}, then `6 · distance` (it must stay beyond `fog.far`). */
export const FAR_BASE = 900;

/**
 * Resolves an app's distance limits — meters, or absent for "keep the engine
 * default" — to world units for a world of `unitMeters` meters per unit. This
 * is the whole meter ⇄ unit conversion: everything downstream is world units.
 */
export function limitsInUnits(limits: { min?: number; max?: number }, unitMeters: number): { min: number; max: number } {
  const u = unitMeters > 0 ? unitMeters : 1;
  return {
    min: limits.min !== undefined ? limits.min / u : DIST_MIN,
    max: limits.max !== undefined ? limits.max / u : DIST_MAX,
  };
}

/** Near plane for a camera distance (world units). */
export const nearFor = (distance: number): number => Math.max(NEAR_BASE, distance / 300);
/** Far plane for a camera distance (world units). */
export const farFor = (distance: number): number => Math.max(FAR_BASE, distance * 6);

export interface CameraOrbit {
  x: number;
  z: number;
  distance: number;
  pitch: number;
  bearing: number;
}

export interface CameraTransition {
  from: CameraOrbit;
  to: CameraOrbit;
  t: number;
  duration: number;
}

/** A follow target provider; return `null` to hold position. */
export type FollowTarget = () => { x: number; z: number } | null;

/** Result of {@link CameraController.worldToScreen}: CSS pixels plus "inside the visible area". */
export interface ScreenProjection {
  x: number;
  y: number;
  visible: boolean;
}

/** A rectangle in CSS pixels, origin top-left. */
export interface ViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The four inset sides in CSS pixels, all present. */
export type Insets = Required<ContentInset>;

/** No content inset. */
export const NO_INSET: Readonly<Insets> = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });

/**
 * Splits one axis of the viewport into "before the visible area" and "how long
 * it is". Insets that together leave nothing are scaled down proportionally so
 * that at least one pixel of map stays visible: a bug in an app's layout must
 * not produce a zero-sized rectangle the rest of the engine divides by.
 */
function visibleAxis(size: number, before: number, after: number): { start: number; length: number } {
  const total = Math.max(0, before) + Math.max(0, after);
  if (total <= 0 || size <= 1) return { start: 0, length: Math.max(1, size) };
  const k = total > size - 1 ? (size - 1) / total : 1;
  return { start: Math.max(0, before) * k, length: Math.max(1, size - total * k) };
}

/** The pitch limits in force, in degrees. `min === max` means the pitch is pinned (2D view). */
export interface PitchLimits {
  min: number;
  max: number;
}

/** The distance limits in force, in world units, and whether the renderer had to narrow the request. */
export interface DistanceLimits {
  min: number;
  max: number;
  /** True when the requested pair did not fit `[DIST_HARD_MIN, DIST_HARD_MAX]` or had `min > max`. */
  clamped: boolean;
}

const ease = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

/** Distance (world units, ≈8 mm at 8 m per unit) below which the follow easing snaps onto its target. */
const FOLLOW_SNAP = 1e-3;

export class CameraController {
  readonly camera: PerspectiveCamera;
  /**
   * The orbit. `x` / `z` are the **anchor**: the ground point the camera keeps
   * at the centre of the *visible area* (the viewport minus {@link inset}).
   * Without an inset that is the centre of the viewport, as before; with one,
   * {@link apply} shifts the three.js camera so the anchor lands there.
   */
  readonly orbit: CameraOrbit = { x: 0, z: 0, distance: 36, pitch: 50, bearing: 28 };
  /** Ground plane height used by picking. */
  groundY = 0;
  width = 1;
  height = 1;
  reduceMotion = false;
  /** What moved the camera last, for `camera:idle.reason`. */
  moveReason: CameraIdleReason = 'api';
  private insets: Insets = { ...NO_INSET };
  /** Cached {@link view}; only a new viewport or inset invalidates it. */
  private readonly viewRect: ViewRect = { x: 0, y: 0, width: 1, height: 1 };
  private viewDirty = true;
  private transition: CameraTransition | null = null;
  /** False while the follow easing is still catching up to its target (see {@link animating}). */
  private followSettled = true;
  private followFn: FollowTarget | null = null;
  private followId: string | null = null;
  private toNorthActive = false;
  private listeners = new Set<() => void>();
  private activityListeners = new Set<() => void>();
  private dirty = true;
  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private readonly tmp = new Vector3();
  private distMin = DIST_MIN;
  private distMax = DIST_MAX;
  private pitchLo = PITCH_MIN;
  private pitchHi = PITCH_MAX;

  constructor(camera?: PerspectiveCamera) {
    this.camera = camera ?? new PerspectiveCamera(CAMERA_FOV_DEG, 1, NEAR_BASE, FAR_BASE);
    this.apply();
  }

  /** The distance limits in force, in world units. */
  get distanceLimits(): { min: number; max: number } {
    return { min: this.distMin, max: this.distMax };
  }

  /**
   * Replaces the distance limits (world units). The pair is clamped into
   * `[DIST_HARD_MIN, DIST_HARD_MAX]` and `max` is raised to `min` when they
   * cross; the current distance is re-clamped immediately. Returns what is
   * actually in force, so the engine can warn about a range it had to narrow.
   */
  setDistanceLimits(min: number, max: number): DistanceLimits {
    const lo = clamp(Number.isFinite(min) ? min : DIST_MIN, DIST_HARD_MIN, DIST_HARD_MAX);
    const hi = clamp(Number.isFinite(max) ? max : DIST_MAX, lo, DIST_HARD_MAX);
    const clamped = lo !== min || hi !== max;
    this.distMin = lo;
    this.distMax = hi;
    const d = this.clampDistance(this.orbit.distance);
    if (d !== this.orbit.distance) {
      this.transition = null;
      this.orbit.distance = d;
      this.markChanged();
    }
    return { min: lo, max: hi, clamped };
  }

  /** Clamps a distance (world units) into the limits in force. */
  clampDistance(distance: number): number {
    return clamp(Number.isFinite(distance) ? distance : this.orbit.distance, this.distMin, this.distMax);
  }

  /** The pitch limits in force, in degrees. */
  get pitchLimits(): Readonly<PitchLimits> {
    return { min: this.pitchLo, max: this.pitchHi };
  }

  /** True while the pitch cannot be changed at all (`min === max`) — the 2D view pins it at 0. */
  get pitchLocked(): boolean {
    return this.pitchHi <= this.pitchLo;
  }

  /**
   * Replaces the pitch limits, in degrees, inside `[PITCH_MIN, PITCH_MAX]`.
   *
   * This is how the 2D view mode owns the pitch: it narrows the window to
   * `[0, 0]` (and, while a view transition runs, to the single interpolated
   * value), which re-clamps the pitch **now** and keeps gestures inside it.
   * A running camera transition is re-clamped too — its target pitch would
   * otherwise tilt the map back up a few frames later — while its position,
   * distance and bearing keep animating untouched, so a `setCamera` and a
   * `setView` issued together do not cancel each other.
   */
  setPitchLimits(min: number, max: number): void {
    const lo = clamp(Number.isFinite(min) ? min : PITCH_MIN, PITCH_MIN, PITCH_MAX);
    const hi = clamp(Number.isFinite(max) ? max : PITCH_MAX, lo, PITCH_MAX);
    if (lo === this.pitchLo && hi === this.pitchHi) return;
    this.pitchLo = lo;
    this.pitchHi = hi;
    const tr = this.transition;
    if (tr) {
      tr.from.pitch = this.clampPitch(tr.from.pitch);
      tr.to.pitch = this.clampPitch(tr.to.pitch);
    }
    const p = this.clampPitch(this.orbit.pitch);
    if (p !== this.orbit.pitch) {
      this.orbit.pitch = p;
      this.markChanged();
    }
  }

  /** Clamps a pitch (degrees) into the limits in force. */
  clampPitch(pitch: number): number {
    return clamp(Number.isFinite(pitch) ? pitch : this.orbit.pitch, this.pitchLo, this.pitchHi);
  }

  /** Sets the viewport size in CSS pixels. */
  setViewport(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.viewDirty = true;
    this.markChanged('api');
  }

  /** The content inset in force, in CSS pixels. */
  get inset(): Readonly<Insets> {
    return this.insets;
  }

  /**
   * Replaces the content inset (`ui.contentInset`, dp). The anchor is kept, so
   * the ground point the camera looks at stays at the centre of the *new*
   * visible area: opening a bottom sheet slides the map up instead of leaving
   * the centre under the sheet.
   */
  setInset(inset: ContentInset | undefined): void {
    const next: Insets = {
      top: Math.max(0, inset?.top ?? 0),
      right: Math.max(0, inset?.right ?? 0),
      bottom: Math.max(0, inset?.bottom ?? 0),
      left: Math.max(0, inset?.left ?? 0),
    };
    const cur = this.insets;
    if (next.top === cur.top && next.right === cur.right && next.bottom === cur.bottom && next.left === cur.left) return;
    this.insets = next;
    this.viewDirty = true;
    this.markChanged('api');
  }

  /**
   * The visible area — the viewport minus the content inset — in CSS pixels.
   *
   * Recomputed only when the viewport or the inset changes and returned as the
   * same object every time: {@link worldToScreen} reads it once per projected
   * point, and the per-frame batches (overlay anchors, name tags, markers,
   * labels) project hundreds of them.
   */
  get view(): Readonly<ViewRect> {
    if (this.viewDirty) {
      this.viewDirty = false;
      const h = visibleAxis(this.width, this.insets.left, this.insets.right);
      const v = visibleAxis(this.height, this.insets.top, this.insets.bottom);
      this.viewRect.x = h.start;
      this.viewRect.y = v.start;
      this.viewRect.width = h.length;
      this.viewRect.height = v.length;
    }
    return this.viewRect;
  }

  /** Moves the camera. Unset fields keep their value. `durationMs > 0` animates (skipped with reduced motion). */
  set(o: Partial<CameraOrbit>, durationMs = 0, reason: CameraIdleReason = 'api'): void {
    const to = this.clampOrbit({ ...this.orbit, ...o });
    if (durationMs > 0 && !this.reduceMotion) {
      // shortest rotation
      to.bearing = this.orbit.bearing + wrapDeg(to.bearing - this.orbit.bearing);
      this.transition = { from: { ...this.orbit }, to, t: 0, duration: durationMs / 1000 };
      this.moveReason = reason;
      this.notifyActivity();
    } else {
      this.transition = null;
      Object.assign(this.orbit, to);
      this.markChanged(reason);
    }
    if (o.pitch !== undefined || o.bearing !== undefined) this.toNorthActive = false;
  }

  /** Immediate relative changes from gestures (cancel animations, north-reset and follow for pans). */
  panBy(dx: number, dz: number): void {
    this.transition = null;
    this.followFn = null;
    this.followId = null;
    this.orbit.x += dx;
    this.orbit.z += dz;
    this.markChanged('gesture');
  }

  rotateBy(dBearing: number, dPitch: number): void {
    this.transition = null;
    this.toNorthActive = false;
    this.orbit.bearing = this.orbit.bearing + dBearing;
    this.orbit.pitch = this.clampPitch(this.orbit.pitch + dPitch);
    this.markChanged('gesture');
  }

  zoomTo(distance: number): void {
    this.transition = null;
    this.orbit.distance = this.clampDistance(distance);
    this.markChanged('gesture');
  }

  /** Follows a moving target (part 2 characters). `id` is informational. Pass `null` to stop. */
  follow(target: FollowTarget | null, id: string | null = null): void {
    this.followFn = target;
    this.followId = target ? id : null;
    if (target) {
      this.followSettled = false;
      this.notifyActivity();
    } else this.followSettled = true;
  }

  get followingId(): string | null {
    return this.followId;
  }

  /**
   * Animates bearing to north and pitch to 45° (a map-UI affordance, so
   * `gesture`). The pitch target is clamped into the limits in force, so in the
   * 2D view the button only turns the map north and leaves it flat.
   */
  toNorth(): void {
    this.toNorthActive = true;
    this.moveReason = 'gesture';
    this.notifyActivity();
    if (this.reduceMotion) {
      this.orbit.bearing = 0;
      this.orbit.pitch = this.clampPitch(TO_NORTH_PITCH);
      this.toNorthActive = false;
      this.markChanged('gesture');
    }
  }

  /** Subscribes to camera changes (fires at most once per `update`, after the pose was applied). */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /**
   * Subscribes to camera *activity*: fires synchronously the moment something
   * moves the camera or starts animating it — a gesture, a zoom button, a
   * `set` / `follow` / `toNorth` — i.e. **before** the change is applied.
   *
   * {@link onChange} cannot serve that purpose: it only fires from
   * {@link update}, which the on-demand render loop does not call while the
   * engine is idle. Use this to wake the loop up.
   */
  onActivity(cb: () => void): () => void {
    this.activityListeners.add(cb);
    return () => { this.activityListeners.delete(cb); };
  }

  /** True while the camera is still moving on its own (transition, to-north, or catching up to a follow target). */
  get animating(): boolean {
    return !!this.transition || this.toNorthActive || !this.followSettled;
  }

  /** Advances animations / follow and applies the pose to the three camera. */
  update(dt: number): void {
    if (this.transition) {
      const tr = this.transition;
      tr.t = Math.min(1, tr.t + dt / Math.max(1e-3, tr.duration));
      const k = ease(tr.t);
      for (const key of ['x', 'z', 'distance', 'pitch', 'bearing'] as const) this.orbit[key] = tr.from[key] + (tr.to[key] - tr.from[key]) * k;
      if (tr.t >= 1) this.transition = null;
      this.dirty = true;
    }
    if (this.followFn) {
      const p = this.followFn();
      if (p) {
        const k = this.reduceMotion ? 1 : 1 - Math.exp(-dt * 5);
        let nx = this.orbit.x + (p.x - this.orbit.x) * k, nz = this.orbit.z + (p.z - this.orbit.z) * k;
        // The exponential easing only approaches the target: snap below a sub-pixel distance so
        // following a standing character terminates instead of rendering forever.
        if (Math.abs(p.x - nx) < FOLLOW_SNAP) nx = p.x;
        if (Math.abs(p.z - nz) < FOLLOW_SNAP) nz = p.z;
        if (nx !== this.orbit.x || nz !== this.orbit.z) {
          this.orbit.x = nx;
          this.orbit.z = nz;
          this.dirty = true;
          this.moveReason = 'follow';
        }
        this.followSettled = nx === p.x && nz === p.z;
      } else this.followSettled = true;
    }
    if (this.toNorthActive) {
      const d = wrapDeg(-this.orbit.bearing);
      const k = Math.min(1, dt * 6);
      const targetPitch = this.clampPitch(TO_NORTH_PITCH);
      this.orbit.bearing += d * k;
      this.orbit.pitch += (targetPitch - this.orbit.pitch) * k;
      if (Math.abs(d) < 0.3 && Math.abs(targetPitch - this.orbit.pitch) < 0.3) {
        this.orbit.bearing = 0;
        this.orbit.pitch = targetPitch;
        this.toNorthActive = false;
      }
      this.dirty = true;
    }
    if (this.dirty) {
      this.apply();
      this.dirty = false;
      for (const cb of [...this.listeners]) cb();
    }
  }

  /**
   * Ground offset (world units) from the point under the centre of the whole
   * viewport to the point under the centre of the **visible area**, at the
   * current pose. `{ x: 0, z: 0 }` without an inset.
   *
   * The camera pose is a pure translation in `x` / `z`, so this offset is the
   * whole correction: looking at `anchor − shift` puts `anchor` under the
   * visible centre exactly, with no iteration.
   */
  insetShift(pose: Pick<CameraOrbit, 'distance' | 'pitch' | 'bearing'> = this.orbit): { x: number; z: number } {
    const i = this.insets;
    if (i.top === 0 && i.right === 0 && i.bottom === 0 && i.left === 0) return { x: 0, z: 0 };
    const v = this.view, o = pose;
    const basis = basisFor(0, 0, o.distance, o.pitch, o.bearing);
    const hit = groundAt(basis, v.x + v.width / 2, v.y + v.height / 2, this.width, this.height, Math.tan((this.camera.fov * DEG) / 2));
    return hit ?? { x: 0, z: 0 };
  }

  /** Applies the orbit to the three camera immediately. */
  apply(): void {
    const o = this.orbit;
    // The frustum follows the distance: a wide view needs its far plane beyond the (equally
    // widened) fog, and its near plane raised with it so the depth range keeps its precision.
    const near = nearFor(o.distance), far = farFor(o.distance);
    if (this.camera.near !== near || this.camera.far !== far) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
    // The three camera still looks at the centre of the *viewport*; the content inset moves that
    // look-at point so the anchor (`orbit.x/z`) ends up under the centre of the visible area.
    const s = this.insetShift();
    const tx = o.x - s.x, tz = o.z - s.z;
    const p = o.pitch * DEG, b = o.bearing * DEG, h = o.distance * Math.sin(p);
    // forward (ground) = (sin b, −cos b); camera sits behind the target
    this.camera.position.set(tx - Math.sin(b) * h, this.groundY + o.distance * Math.cos(p), tz + Math.cos(b) * h);
    this.camera.up.set(Math.sin(b), 0, -Math.cos(b));
    this.camera.lookAt(tx, this.groundY, tz);
    this.camera.updateMatrixWorld();
  }

  /**
   * The four ground corners of the **visible area**, in world units and in
   * `[top-left, top-right, bottom-right, bottom-left]` order.
   *
   * A corner whose ray runs past the horizon — it misses the ground plane, or
   * hits it farther than `maxDistance` from the anchor — is pulled back to
   * `maxDistance` along the same ground direction, so the result is always a
   * usable quad (protocol `CAMERA_IDLE_HORIZON_FACTOR`).
   */
  groundCorners(maxDistance: number): { x: number; z: number }[] {
    const v = this.view;
    const x0 = v.x, y0 = v.y, x1 = v.x + v.width, y1 = v.y + v.height;
    return [
      this.groundOrClamped(x0, y0, maxDistance),
      this.groundOrClamped(x1, y0, maxDistance),
      this.groundOrClamped(x1, y1, maxDistance),
      this.groundOrClamped(x0, y1, maxDistance),
    ];
  }

  /** Ground point under a pixel, pulled back to `maxDistance` from the anchor when it runs to the horizon. */
  private groundOrClamped(px: number, py: number, maxDistance: number): { x: number; z: number } {
    const ray = this.rayAt(px, py).ray;
    const o = this.orbit, dir = ray.direction, org = ray.origin;
    const limit = Math.max(1e-6, maxDistance);
    if (dir.y < -1e-9) {
      const t = (this.groundY - org.y) / dir.y;
      if (t > 0) {
        const hx = org.x + dir.x * t, hz = org.z + dir.z * t;
        const dx = hx - o.x, dz = hz - o.z, d = Math.hypot(dx, dz);
        return d <= limit ? { x: hx, z: hz } : { x: o.x + (dx / d) * limit, z: o.z + (dz / d) * limit };
      }
    }
    // Above the horizon (or parallel to the ground): go `limit` along the ray's ground direction.
    const hl = Math.hypot(dir.x, dir.z) || 1;
    return { x: o.x + (dir.x / hl) * limit, z: o.z + (dir.z / hl) * limit };
  }

  /**
   * Projects a world point to CSS pixels (origin top-left of the **whole**
   * map view — the content inset never moves the coordinate frame). `visible`
   * is "inside the visible area", i.e. inset-aware. Pass `out` to write into
   * an existing object instead of allocating one — used by the per-frame
   * batches (overlay anchors, name tags), which would otherwise allocate one
   * short-lived object per item per frame.
   */
  worldToScreen<T extends ScreenProjection>(x: number, y: number, z: number, out: T): T;
  worldToScreen(x: number, y: number, z: number): ScreenProjection;
  worldToScreen(x: number, y: number, z: number, out?: ScreenProjection): ScreenProjection {
    const v = this.tmp.set(x, y, z).project(this.camera);
    const sx = (v.x * 0.5 + 0.5) * this.width, sy = (-v.y * 0.5 + 0.5) * this.height;
    const inFront = v.z >= -1 && v.z <= 1;
    const r = this.view;
    const visible = inFront && sx >= r.x && sx <= r.x + r.width && sy >= r.y && sy <= r.y + r.height;
    if (!out) return { x: sx, y: sy, visible };
    out.x = sx;
    out.y = sy;
    out.visible = visible;
    return out;
  }

  /** Ray from CSS pixel coordinates (relative to the viewport). */
  rayAt(px: number, py: number): Raycaster {
    this.ndc.set((px / this.width) * 2 - 1, -(py / this.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    return this.raycaster;
  }

  /** Ground-plane intersection at CSS pixel coordinates, or `null` when the ray misses. */
  screenToGround(px: number, py: number): { x: number; z: number } | null {
    const ray = this.rayAt(px, py).ray;
    const hit = ray.intersectPlane(new Plane(new Vector3(0, 1, 0), -this.groundY), this.tmp);
    return hit ? { x: hit.x, z: hit.z } : null;
  }

  private clampOrbit(o: CameraOrbit): CameraOrbit {
    return {
      x: Number.isFinite(o.x) ? o.x : 0,
      z: Number.isFinite(o.z) ? o.z : 0,
      distance: this.clampDistance(o.distance),
      pitch: this.clampPitch(o.pitch),
      bearing: Number.isFinite(o.bearing) ? o.bearing : 0,
    };
  }

  private markChanged(reason: CameraIdleReason = 'api'): void {
    this.dirty = true;
    this.moveReason = reason;
    this.notifyActivity();
  }

  private notifyActivity(): void {
    for (const cb of [...this.activityListeners]) cb();
  }
}
