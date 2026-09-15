/**
 * Camera controller: orbit state (target, distance, pitch, bearing), limits,
 * animated transitions, follow target (for part 2 characters), "to north",
 * and screen ⇄ world projection. Uses three.js math only (no WebGL), so it
 * works in node tests.
 *
 * Conventions (match `@diorama/protocol` `CameraSpec`):
 * - `pitch` degrees, 0 = straight down, clamped to 0–60.
 * - `bearing` degrees clockwise from north = the compass direction at the top of the screen.
 * - `distance` world units here (the protocol uses meters; convert with `unitMeters`), clamped to 14–150.
 *
 * @module
 */

import { PerspectiveCamera, Plane, Raycaster, Vector2, Vector3 } from 'three';
import { clamp, DEG, wrapDeg } from '../util/math.js';

export const PITCH_MIN = 0;
export const PITCH_MAX = 60;
export const DIST_MIN = 14;
export const DIST_MAX = 150;

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

const ease = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

export class CameraController {
  readonly camera: PerspectiveCamera;
  readonly orbit: CameraOrbit = { x: 0, z: 0, distance: 36, pitch: 50, bearing: 28 };
  /** Ground plane height used by picking. */
  groundY = 0;
  width = 1;
  height = 1;
  reduceMotion = false;
  private transition: CameraTransition | null = null;
  private followFn: FollowTarget | null = null;
  private followId: string | null = null;
  private toNorthActive = false;
  private listeners = new Set<() => void>();
  private dirty = true;
  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private readonly tmp = new Vector3();

  constructor(camera?: PerspectiveCamera) {
    this.camera = camera ?? new PerspectiveCamera(40, 1, 0.5, 900);
    this.apply();
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
    this.orbit.distance = clamp(distance, DIST_MIN, DIST_MAX);
    this.markChanged();
  }

  /** Follows a moving target (part 2 characters). `id` is informational. Pass `null` to stop. */
  follow(target: FollowTarget | null, id: string | null = null): void {
    this.followFn = target;
    this.followId = target ? id : null;
  }

  get followingId(): string | null {
    return this.followId;
  }

  /** Animates bearing to north and pitch to 45°. */
  toNorth(): void {
    this.toNorthActive = true;
    if (this.reduceMotion) {
      this.orbit.bearing = 0;
      this.orbit.pitch = 45;
      this.toNorthActive = false;
      this.markChanged();
    }
  }

  /** Subscribes to camera changes (fires at most once per `update`). */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
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
        const nx = this.orbit.x + (p.x - this.orbit.x) * k, nz = this.orbit.z + (p.z - this.orbit.z) * k;
        if (Math.abs(nx - this.orbit.x) > 1e-5 || Math.abs(nz - this.orbit.z) > 1e-5) {
          this.orbit.x = nx;
          this.orbit.z = nz;
          this.dirty = true;
        }
      }
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
      distance: clamp(o.distance, DIST_MIN, DIST_MAX),
      pitch: clamp(o.pitch, PITCH_MIN, PITCH_MAX),
      bearing: Number.isFinite(o.bearing) ? o.bearing : 0,
    };
  }

  private markChanged(): void {
    this.dirty = true;
  }
}
