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
 * @module
 */

import { CAMERA_FOV_DEG } from '@maprama/protocol';
import { PerspectiveCamera, Plane, Raycaster, Vector2, Vector3 } from 'three';
import { clamp, DEG, wrapDeg } from '../util/math.js';

export const PITCH_MIN = 0;
export const PITCH_MAX = 60;
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
  readonly orbit: CameraOrbit = { x: 0, z: 0, distance: 36, pitch: 50, bearing: 28 };
  /** Ground plane height used by picking. */
  groundY = 0;
  width = 1;
  height = 1;
  reduceMotion = false;
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

  /** Sets the viewport size in CSS pixels. */
  setViewport(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.markChanged();
  }

  /** Moves the camera. Unset fields keep their value. `durationMs > 0` animates (skipped with reduced motion). */
  set(o: Partial<CameraOrbit>, durationMs = 0): void {
    const to = this.clampOrbit({ ...this.orbit, ...o });
    if (durationMs > 0 && !this.reduceMotion) {
      // shortest rotation
      to.bearing = this.orbit.bearing + wrapDeg(to.bearing - this.orbit.bearing);
      this.transition = { from: { ...this.orbit }, to, t: 0, duration: durationMs / 1000 };
      this.notifyActivity();
    } else {
      this.transition = null;
      Object.assign(this.orbit, to);
      this.markChanged();
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
    this.markChanged();
  }

  rotateBy(dBearing: number, dPitch: number): void {
    this.transition = null;
    this.toNorthActive = false;
    this.orbit.bearing = this.orbit.bearing + dBearing;
    this.orbit.pitch = clamp(this.orbit.pitch + dPitch, PITCH_MIN, PITCH_MAX);
    this.markChanged();
  }

  zoomTo(distance: number): void {
    this.transition = null;
    this.orbit.distance = this.clampDistance(distance);
    this.markChanged();
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

  /** Animates bearing to north and pitch to 45°. */
  toNorth(): void {
    this.toNorthActive = true;
    this.notifyActivity();
    if (this.reduceMotion) {
      this.orbit.bearing = 0;
      this.orbit.pitch = 45;
      this.toNorthActive = false;
      this.markChanged();
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
        }
        this.followSettled = nx === p.x && nz === p.z;
      } else this.followSettled = true;
    }
    if (this.toNorthActive) {
      const d = wrapDeg(-this.orbit.bearing);
      const k = Math.min(1, dt * 6);
      this.orbit.bearing += d * k;
      this.orbit.pitch += (45 - this.orbit.pitch) * k;
      if (Math.abs(d) < 0.3 && Math.abs(45 - this.orbit.pitch) < 0.3) {
        this.orbit.bearing = 0;
        this.orbit.pitch = 45;
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
    const p = o.pitch * DEG, b = o.bearing * DEG, h = o.distance * Math.sin(p);
    // forward (ground) = (sin b, −cos b); camera sits behind the target
    this.camera.position.set(o.x - Math.sin(b) * h, this.groundY + o.distance * Math.cos(p), o.z + Math.cos(b) * h);
    this.camera.up.set(Math.sin(b), 0, -Math.cos(b));
    this.camera.lookAt(o.x, this.groundY, o.z);
    this.camera.updateMatrixWorld();
  }

  /** Projects a world point to CSS pixels (origin top-left). */
  worldToScreen(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
    const v = this.tmp.set(x, y, z).project(this.camera);
    const sx = (v.x * 0.5 + 0.5) * this.width, sy = (-v.y * 0.5 + 0.5) * this.height;
    const inFront = v.z >= -1 && v.z <= 1;
    const visible = inFront && sx >= 0 && sx <= this.width && sy >= 0 && sy <= this.height;
    return { x: sx, y: sy, visible };
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
      pitch: clamp(o.pitch, PITCH_MIN, PITCH_MAX),
      bearing: Number.isFinite(o.bearing) ? o.bearing : 0,
    };
  }

  private markChanged(): void {
    this.dirty = true;
    this.notifyActivity();
  }

  private notifyActivity(): void {
    for (const cb of [...this.activityListeners]) cb();
  }
}
