/**
 * Location sources: the simulated demo loop, host-pushed fixes (`external`)
 * and device geolocation (`navigator.geolocation.watchPosition`), with the
 * prototype's alpha-beta smoothing, outlier rejection and road matching.
 *
 * The smoother, the demo walker and the trip builder are pure and tested in
 * node; {@link LocationService} only touches `navigator` for the `device`
 * source.
 *
 * @module
 */

import type { LocationFix, LocationSourceKind, LngLat, WorldPoint } from '@maprama/protocol';
import { clamp } from '../util/math.js';
import { route, snap, type RoadGraph } from '../world/graph.js';
import type { WorldModel } from '../world/model.js';
import { pathLength, roadPath } from './follower.js';

/**
 * Ground-truth pace of the `simulated` demo loop in world units per second:
 * the prototype's fast-forward demo walking pace (3.2 units/s × 0.95), kept
 * independent of travel speed and `timeScale`.
 */
export const SIMULATED_WALK_SPEED = 3.2 * 0.95;

// ---------------------------------------------------------------------------
// Smoothing
// ---------------------------------------------------------------------------

export interface SmootherOptions {
  /** Blend factor of an accepted fix into the prediction (prototype 0.5; 0.6 tracks turns better). */
  gain?: number;
  /** Velocity blend factor (prototype 0.5). */
  velocityGain?: number;
  /**
   * Base outlier gate in world units per second of fix interval (prototype
   * 4.5). The gate widens by the current speed so turns are not rejected.
   */
  outlierUnits?: number;
  /** Velocity clamp in world units per second (prototype 5). */
  maxSpeedUnits?: number;
  /** After this many consecutive rejections the estimate jumps to the fix (recovers from real jumps). */
  maxConsecutiveRejects?: number;
  /** Fixes reporting a worse accuracy (world units) are rejected. */
  maxAccuracyUnits?: number;
}

/** Input fix in world units; `t` in seconds. */
export interface WorldFix {
  x: number;
  z: number;
  t: number;
  /** Reported accuracy radius in world units. */
  accuracy?: number;
}

/** Result of {@link GpsSmoother.push}. */
export interface SmoothedFix {
  /** Smoothed estimate. */
  x: number;
  z: number;
  /** Running accuracy estimate in world units. */
  accuracy: number;
  /** True when the fix was rejected as an outlier (the estimate follows the prediction). */
  rejected: boolean;
  /** Estimated velocity in world units per second. */
  vx: number;
  vz: number;
}

/**
 * Alpha-beta filter with outlier rejection (prototype `stepGps`), with three
 * fixes for the prototype's divergence at corners (measured on the demo loop:
 * the prototype's estimate ran away once a turn was rejected):
 * - the gate is `outlierUnits + speed` (per second of fix interval);
 * - a fix is an outlier only when it is far from both the prediction and the
 *   current estimate;
 * - consecutive rejections snap the estimate to the fix
 *   (`maxConsecutiveRejects`).
 */
export class GpsSmoother {
  est: { x: number; z: number } | null = null;
  vel = { x: 0, z: 0 };
  /** Running accuracy estimate in world units (prototype starts at 1.2). */
  acc = 1.2;
  private lastT: number | null = null;
  private rejects = 0;
  private readonly o: Required<SmootherOptions>;

  constructor(options: SmootherOptions = {}) {
    this.o = { gain: 0.6, velocityGain: 0.7, outlierUnits: 4.5, maxSpeedUnits: 5, maxConsecutiveRejects: 3, maxAccuracyUnits: 12.5, ...options };
  }

  reset(): void {
    this.est = null;
    this.vel = { x: 0, z: 0 };
    this.acc = 1.2;
    this.lastT = null;
    this.rejects = 0;
  }

  push(fix: WorldFix): SmoothedFix {
    const o = this.o;
    const dt = this.lastT === null ? 1 : clamp(fix.t - this.lastT, 0.05, 5);
    this.lastT = fix.t;
    let rejected = false;
    if (!this.est) {
      this.est = { x: fix.x, z: fix.z };
      this.vel = { x: 0, z: 0 };
    } else {
      const px = this.est.x + this.vel.x * dt, pz = this.est.z + this.vel.z * dt;
      const ix = fix.x - px, iz = fix.z - pz, inn = Math.hypot(ix, iz);
      const gate = (o.outlierUnits + Math.hypot(this.vel.x, this.vel.z)) * Math.max(1, dt);
      const far = Math.min(inn, Math.hypot(fix.x - this.est.x, fix.z - this.est.z)) > gate;
      rejected = far || (fix.accuracy !== undefined && fix.accuracy > o.maxAccuracyUnits);
      if (rejected && ++this.rejects >= o.maxConsecutiveRejects) {
        // the "outliers" agree with each other: the device really moved
        this.est = { x: fix.x, z: fix.z };
        this.vel = { x: 0, z: 0 };
        this.acc = Math.max(this.acc, fix.accuracy ?? inn / 2);
        this.rejects = 0;
        rejected = false;
      } else if (!rejected) {
        this.rejects = 0;
        const nx = px + ix * o.gain, nz = pz + iz * o.gain;
        this.vel.x += ((nx - this.est.x) / dt - this.vel.x) * o.velocityGain;
        this.vel.z += ((nz - this.est.z) / dt - this.vel.z) * o.velocityGain;
        const vm = Math.hypot(this.vel.x, this.vel.z);
        if (vm > o.maxSpeedUnits) {
          this.vel.x *= o.maxSpeedUnits / vm;
          this.vel.z *= o.maxSpeedUnits / vm;
        }
        this.est = { x: nx, z: nz };
        this.acc += ((fix.accuracy ?? inn) - this.acc) * 0.25;
      } else {
        this.est = { x: px, z: pz };
      }
    }
    return { x: this.est.x, z: this.est.z, accuracy: this.acc, rejected, vx: this.vel.x, vz: this.vel.z };
  }
}

// ---------------------------------------------------------------------------
// Simulated walker
// ---------------------------------------------------------------------------

/** Standard normal sample (Box-Muller). */
export function gauss(rng: () => number): number {
  let u = 0, v = 0;
  while (!u) u = rng();
  while (!v) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * The demo loop (prototype `buildGpsLoop`): the world's `loopWays` joined by
 * road routes. Worlds without `loopWays` (real data) get a loop through four
 * road points around the start.
 */
export function buildDemoLoop(world: Pick<WorldModel, 'graph' | 'loopWays' | 'start'>): WorldPoint[] {
  const g = world.graph;
  let ways = world.loopWays.map(([x, z]) => ({ x, z }));
  if (ways.length < 2) {
    const s = world.start, r = 18;
    ways = [{ x: s.x - r, z: s.z - r }, { x: s.x + r, z: s.z - r }, { x: s.x + r, z: s.z + r }, { x: s.x - r, z: s.z + r }];
  }
  const pts: WorldPoint[] = [];
  for (let i = 0; i < ways.length; i++) {
    const a = ways[i]!, b = ways[(i + 1) % ways.length]!;
    const sa = snap(g, a.x, a.z), sb = snap(g, b.x, b.z);
    const seg = sa && sb ? route(g, sa, sb) : [a, b];
    seg.forEach((p, k) => { if (!(k === 0 && pts.length)) pts.push({ x: p.x, z: p.z }); });
  }
  const out = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1]!.x, p.z - pts[i - 1]!.z) > 0.05);
  if (out.length < 2) return [{ ...world.start }, { x: world.start.x + 1, z: world.start.z }];
  return out;
}

/** Walks the demo loop and produces noisy fixes once per second (prototype GPS simulation). */
export class SimulatedWalker {
  seg = 0;
  t = 0;
  truth: WorldPoint;
  private timer = 0;

  constructor(readonly loop: WorldPoint[], private readonly rng: () => number = Math.random, private readonly speed = SIMULATED_WALK_SPEED) {
    this.truth = { ...loop[0]! };
  }

  /** Advances the ground truth; returns a noisy fix when one is due. */
  step(dt: number): { x: number; z: number; outlier: boolean } | null {
    const L = this.loop.length;
    const a = this.loop[this.seg]!, b = this.loop[(this.seg + 1) % L]!;
    this.t += (this.speed * dt) / Math.max(0.2, Math.hypot(b.x - a.x, b.z - a.z));
    while (this.t >= 1) {
      this.t -= 1;
      this.seg = (this.seg + 1) % L;
    }
    const a2 = this.loop[this.seg]!, b2 = this.loop[(this.seg + 1) % L]!;
    this.truth = { x: a2.x + (b2.x - a2.x) * this.t, z: a2.z + (b2.z - a2.z) * this.t };
    this.timer -= dt;
    if (this.timer > 0) return null;
    this.timer = 1;
    const outlier = this.rng() < 0.1, sd = outlier ? 5.5 : 0.9;
    return { x: this.truth.x + gauss(this.rng) * sd, z: this.truth.z + gauss(this.rng) * sd, outlier };
  }

  /** Makes the next {@link step} produce a fix immediately. */
  kick(): void {
    this.timer = 0;
  }
}

// ---------------------------------------------------------------------------
// Road matching
// ---------------------------------------------------------------------------

/** Estimates farther than this from any road (world units) are followed off-road. */
export const MAX_SNAP_UNITS = 4;

/**
 * Walk trip from a character to a location estimate (prototype: route along
 * the network with speed `clamp(L / 1.05, 0, 8)`, still when closer than
 * 0.25). Estimates away from roads are approached in a straight line.
 */
export function locationTrip(graph: RoadGraph, from: WorldPoint, est: WorldPoint, maxSnap = MAX_SNAP_UNITS): { pts: WorldPoint[]; speed: number } {
  const se = snap(graph, est.x, est.z);
  let pts: WorldPoint[];
  if (se && se.dist <= maxSnap) {
    const sf = snap(graph, from.x, from.z);
    pts = sf ? route(graph, sf, se) : [from, { x: se.x, z: se.z }];
    if (sf && sf.dist > 0.05) pts = [{ ...from }, ...pts];
  } else pts = roadPath({ graph: { nodes: [], edges: [], adj: [], roads: [] }, stations: [] }, from, est);
  const L = pathLength(pts);
  return { pts, speed: L < 0.25 ? 0 : clamp(L / 1.05, 0, 8) };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface LocationServiceDeps {
  world(): WorldModel | null;
  toWorld(ll: LngLat): WorldPoint;
  /** Called with each processed fix (after smoothing). */
  onFix(fix: SmoothedFix & { raw: WorldPoint; headingDeg?: number }): void;
  onError(code: string, message: string): void;
  /** Seconds (monotonic). */
  now(): number;
  rng?: () => number;
}

/** Drives the active location source. */
export class LocationService {
  kind: LocationSourceKind = 'simulated';
  readonly smoother = new GpsSmoother();
  walker: SimulatedWalker | null = null;
  last: (SmoothedFix & { raw: WorldPoint }) | null = null;
  private watchId: number | null = null;

  constructor(private readonly deps: LocationServiceDeps) {}

  /**
   * True while the source produces fixes from {@link step} — only the
   * simulated walker does. `device` and `external` fixes arrive from outside
   * a frame, so they ask for a frame instead of holding one.
   */
  get animating(): boolean {
    return this.kind === 'simulated' && !!this.walker;
  }

  setKind(kind: LocationSourceKind): void {
    if (kind === this.kind && (kind !== 'device' || this.watchId !== null)) return;
    this.stopDevice();
    this.kind = kind;
    this.smoother.reset();
    this.last = null;
    if (kind === 'simulated') this.walker?.kick();
    if (kind === 'device') this.startDevice();
  }

  worldChanged(world: WorldModel): void {
    this.walker = new SimulatedWalker(buildDemoLoop(world), this.deps.rng);
    this.smoother.reset();
    this.last = null;
    if (this.kind === 'device' && this.watchId === null) this.startDevice();
  }

  /** Accepts a host fix; ignored unless the source is `external`. Returns whether it was used. */
  push(fix: LocationFix): boolean {
    if (this.kind !== 'external') return false;
    this.accept(fix);
    return true;
  }

  step(dt: number): void {
    if (this.kind !== 'simulated' || !this.walker) return;
    const f = this.walker.step(dt);
    if (!f) return;
    this.process({ x: f.x, z: f.z, t: this.deps.now() });
  }

  dispose(): void {
    this.stopDevice();
  }

  private accept(fix: LocationFix): void {
    const w = this.deps.world();
    if (!w) return;
    const p = this.deps.toWorld(fix);
    const wf: WorldFix = { x: p.x, z: p.z, t: fix.timestamp / 1000 };
    if (fix.accuracyMeters !== undefined) wf.accuracy = fix.accuracyMeters / w.unitMeters;
    this.process(wf, fix.headingDeg);
  }

  private process(fix: WorldFix, headingDeg?: number): void {
    const s = this.smoother.push(fix);
    const out: SmoothedFix & { raw: WorldPoint; headingDeg?: number } = { ...s, raw: { x: fix.x, z: fix.z } };
    if (headingDeg !== undefined) out.headingDeg = headingDeg;
    this.last = out;
    this.deps.onFix(out);
  }

  private startDevice(): void {
    const geo = typeof navigator !== 'undefined' ? navigator.geolocation : undefined;
    if (!geo) {
      this.deps.onError('location_unavailable', 'device geolocation is not available in this WebView (use the external source and pushLocation)');
      return;
    }
    try {
      this.watchId = geo.watchPosition(
        (pos) => {
          const c = pos.coords;
          const fix: LocationFix = { lng: c.longitude, lat: c.latitude, timestamp: pos.timestamp };
          if (Number.isFinite(c.accuracy)) fix.accuracyMeters = c.accuracy;
          if (c.heading !== null && Number.isFinite(c.heading)) fix.headingDeg = c.heading;
          if (c.speed !== null && Number.isFinite(c.speed)) fix.speedMps = c.speed;
          this.accept(fix);
        },
        (err) => this.deps.onError('location_unavailable', `device geolocation failed: ${err.message}`),
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 },
      );
    } catch (e) {
      this.deps.onError('location_unavailable', `device geolocation failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private stopDevice(): void {
    if (this.watchId !== null && typeof navigator !== 'undefined') navigator.geolocation?.clearWatch(this.watchId);
    this.watchId = null;
  }
}
