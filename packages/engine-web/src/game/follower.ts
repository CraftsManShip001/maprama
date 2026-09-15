/**
 * Travel leg planning and path following (prototype `legsFor`, `makeFollower`,
 * `setTrip`, `stepFollower`, `remainingByLeg`). Pure: no three.js, no DOM.
 *
 * Speed tables live here (they are not part of the protocol):
 * - {@link SPEED}: world units per second used for on-screen playback (a
 *   "fast-forward" demo pace, like the prototype).
 * - {@link KMH}: realistic speeds used for ETAs and reported speeds.
 *
 * @module
 */

import type { Station, TravelMode, WorldPoint } from '@diorama/protocol';
import { clamp } from '../util/math.js';
import { route, snap, type RoadGraph } from '../world/graph.js';
import type { WorldKind } from '../world/model.js';

/** Playback speed per mode in world units per second (prototype `SPEED`). */
export const SPEED: Readonly<Record<TravelMode, number>> = Object.freeze({ walk: 3.2, bike: 7.5, car: 13, plane: 22, subway: 16 });

/** Realistic speed per mode in km/h used for ETAs (prototype `KMH`). */
export const KMH: Readonly<Record<TravelMode, number>> = Object.freeze({ walk: 4.8, bike: 15, car: 30, plane: 180, subway: 60 });

/** Trips shorter than this (world units) fly as a walk instead (prototype). */
export const PLANE_MIN_UNITS = 12;
/** Maximum plane altitude in world units. */
export const PLANE_MAX_ALTITUDE = 16;
/** Pop-in wait (seconds) when a trip starts in a vehicle. */
export const MODE_SWITCH_WAIT_START = 0.4;
/** Pop-in wait (seconds) when a leg switches vehicles. */
export const MODE_SWITCH_WAIT = 0.45;

/** One leg of a trip in world units. */
export interface Leg {
  mode: TravelMode;
  pts: WorldPoint[];
  /** Boarding and exit stations of a subway leg. */
  stations?: [Station, Station];
}

/** The parts of a world the planner needs. */
export interface PlanWorld {
  graph: RoadGraph;
  stations: readonly Station[];
}

/** Ground height characters stand on, per world kind (prototype `GROUND_Y`). */
export function groundYFor(kind: WorldKind | undefined): number {
  return kind === 'grid' ? 0.05 : 0.09;
}

const dist = (a: WorldPoint, b: WorldPoint): number => Math.hypot(b.x - a.x, b.z - a.z);

/** Length of a polyline in world units. */
export function pathLength(pts: readonly WorldPoint[]): number {
  let d = 0;
  for (let i = 0; i < pts.length - 1; i++) d += dist(pts[i]!, pts[i + 1]!);
  return d;
}

function dedupe(pts: WorldPoint[]): WorldPoint[] {
  const out: WorldPoint[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || dist(p, q) > 0.01) out.push({ x: p.x, z: p.z });
  }
  return out;
}

/** Road path from `a` to `b`: `a`, the snapped network route, `b`. Straight line without a network. */
export function roadPath(world: PlanWorld, a: WorldPoint, b: WorldPoint): WorldPoint[] {
  const sa = snap(world.graph, a.x, a.z), sb = snap(world.graph, b.x, b.z);
  if (!sa || !sb) return dedupe([a, b]);
  const pts = route(world.graph, sa, sb);
  // unreachable end: go straight from the last reachable point
  return dedupe([a, ...pts, b]);
}

/** Nearest station to a point, or `null` when the world has none. */
export function nearestStation(stations: readonly Station[], p: WorldPoint): Station | null {
  let best: Station | null = null, bd = Infinity;
  for (const s of stations) {
    const d = Math.hypot(s.x - p.x, s.z - p.z);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

/** Collapses consecutive duplicate modes; an empty list becomes `['walk']`. */
export function normalizeModes(modes: readonly TravelMode[]): TravelMode[] {
  const out: TravelMode[] = [];
  for (const m of modes) if (out[out.length - 1] !== m) out.push(m);
  return out.length ? out : ['walk'];
}

/** Splits a polyline into `n` consecutive parts of equal length. */
export function splitByLength(pts: readonly WorldPoint[], n: number): WorldPoint[][] {
  if (n <= 1) return [pts.map((p) => ({ ...p }))];
  const total = pathLength(pts);
  const parts: WorldPoint[][] = [];
  let cur: WorldPoint[] = [{ ...pts[0]! }];
  let acc = 0, k = 1;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!, b = pts[i + 1]!, seg = dist(a, b);
    while (k < n && acc + seg >= (total * k) / n && seg > 0) {
      const t = ((total * k) / n - acc) / seg;
      const p = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
      cur.push(p);
      parts.push(cur);
      cur = [{ ...p }];
      k++;
    }
    cur.push({ ...b });
    acc += seg;
  }
  parts.push(cur);
  while (parts.length < n) parts.push([{ ...pts[pts.length - 1]! }]);
  return parts.map(dedupe);
}

function planRoadModes(world: PlanWorld, from: WorldPoint, to: WorldPoint, chain: TravelMode[]): Leg[] {
  const pts = roadPath(world, from, to);
  if (chain.length === 1) return [{ mode: chain[0]!, pts }];
  const lead = chain[0] === 'walk', trail = chain[chain.length - 1] === 'walk';
  const middle = chain.slice(lead ? 1 : 0, trail ? chain.length - 1 : chain.length);
  // prototype "mixed": too short a route to switch modes → walk it
  if (!middle.length || pts.length < (lead ? 1 : 0) + (trail ? 1 : 0) + 2) return [{ mode: 'walk', pts }];
  const legs: Leg[] = [];
  const start = lead ? 1 : 0, end = trail ? pts.length - 2 : pts.length - 1;
  if (lead) legs.push({ mode: 'walk', pts: pts.slice(0, 2) });
  const inner = pts.slice(start, end + 1);
  splitByLength(inner, middle.length).forEach((p, i) => legs.push({ mode: middle[i]!, pts: p }));
  if (trail) legs.push({ mode: 'walk', pts: pts.slice(pts.length - 2) });
  return legs;
}

function planChain(world: PlanWorld, from: WorldPoint, to: WorldPoint, chain: TravelMode[]): Leg[] {
  const k = chain.findIndex((m) => m === 'subway' || m === 'plane');
  if (k < 0) return planRoadModes(world, from, to, chain);
  const before = chain.slice(0, k), after = chain.slice(k + 1);
  const replaced = (m: TravelMode): TravelMode[] => normalizeModes([...before, m, ...after]);
  if (chain[k] === 'plane') {
    if (dist(from, to) < PLANE_MIN_UNITS) return planChain(world, from, to, replaced('walk'));
    return [{ mode: 'plane', pts: [{ ...from }, { ...to }] }];
  }
  const sa = nearestStation(world.stations, from), sb = nearestStation(world.stations, to);
  if (!sa || !sb || sa === sb) return planChain(world, from, to, replaced('walk'));
  const pa = snap(world.graph, sa.x, sa.z) ?? { x: sa.x, z: sa.z };
  const pb = snap(world.graph, sb.x, sb.z) ?? { x: sb.x, z: sb.z };
  return [
    ...planChain(world, from, { x: pa.x, z: pa.z }, before.length ? before : ['walk']),
    { mode: 'subway', pts: [{ x: pa.x, z: pa.z }, { x: pb.x, z: pb.z }], stations: [sa, sb] },
    ...planChain(world, { x: pb.x, z: pb.z }, to, after.length ? after : ['walk']),
  ];
}

/**
 * Plans the legs of a trip for an ordered mode list:
 * - `walk` / `bike` / `car` follow the road network (with the off-road start
 *   and end points).
 * - Several road modes split the route: a leading / trailing `walk` covers
 *   the access segment, the other modes share the rest by length
 *   (`['walk', 'car', 'walk']` is the prototype's "mixed" mode).
 * - `plane` flies straight (an arc) from the start to the destination; trips
 *   shorter than {@link PLANE_MIN_UNITS} walk instead. The flight replaces the
 *   whole chain: modes around `plane` add no legs, so `['walk', 'plane',
 *   'walk']` yields a single straight `plane` leg (no walk to or from an
 *   airport).
 * - `subway` walks to the nearest station, rides to the station nearest the
 *   destination and walks on. With fewer than two distinct stations it
 *   falls back to walking.
 *
 * Empty and zero-length legs are removed and consecutive legs of the same
 * mode merged. A trip to the start point has no legs.
 */
export function planLegs(world: PlanWorld, from: WorldPoint, to: WorldPoint, modes: readonly TravelMode[]): Leg[] {
  const raw = planChain(world, from, to, normalizeModes(modes));
  const out: Leg[] = [];
  for (const leg of raw) {
    const pts = dedupe(leg.pts);
    if (pts.length < 2) continue;
    const prev = out[out.length - 1];
    if (prev && prev.mode === leg.mode && leg.mode !== 'subway' && leg.mode !== 'plane') {
      prev.pts = dedupe([...prev.pts, ...pts]);
      continue;
    }
    const l: Leg = { mode: leg.mode, pts };
    if (leg.stations) l.stations = leg.stations;
    out.push(l);
  }
  return out;
}

/** Plane altitude over the ground at progress `t` (0..1) of a flight of `length` units. */
export function planeAltitude(t: number, length: number): number {
  return Math.sin(Math.PI * clamp(t, 0, 1)) * Math.min(PLANE_MAX_ALTITUDE, length * 0.3);
}

/** Seconds needed for `meters` in `mode` at realistic speed. */
export function etaSeconds(meters: number, mode: TravelMode, kmh: Readonly<Record<TravelMode, number>> = KMH): number {
  return meters / (kmh[mode] / 3.6);
}

/** A body moved by a {@link Follower} (a character). */
export interface FollowerBody {
  x: number;
  y: number;
  z: number;
  /** Current speed in world units per second (written by the follower). */
  speed: number;
  /** Desired yaw (`atan2(dx, dz)`), written by the follower. */
  targetYaw: number;
  /** Plane nose pitch (radians), written during plane legs. */
  planePitch: number;
  /** Switches the visible vehicle; returns true when the mode changed. */
  setMode(mode: TravelMode): boolean;
}

/** Remaining distance of one leg. */
export interface LegRemaining {
  mode: TravelMode;
  /** World units. */
  d: number;
}

/** Moves a body along trip legs (prototype follower). */
export class Follower {
  legs: Leg[] = [];
  li = 0;
  si = 0;
  wait = 0;
  speedOverride: number | null = null;
  /** Called once when the last leg is completed. */
  onArrive: (() => void) | null = null;

  constructor(readonly body: FollowerBody, public groundY = 0) {}

  get active(): boolean {
    return this.legs.length > 0;
  }

  /** Mode of the current leg, or `null` when idle. */
  get mode(): TravelMode | null {
    return this.legs[this.li]?.mode ?? null;
  }

  /** Starts a trip (or stops with `[]`). `speedOverride` replaces the per-mode speed. */
  setTrip(legs: Leg[], speedOverride: number | null = null): void {
    this.legs = legs;
    this.li = 0;
    this.si = 0;
    this.speedOverride = speedOverride;
    this.wait = 0;
    const first = legs[0];
    if (first && this.body.setMode(first.mode) && first.mode !== 'walk') this.wait = MODE_SWITCH_WAIT_START;
  }

  /** Advances by `dt` seconds. */
  step(dt: number, speeds: Readonly<Record<TravelMode, number>> = SPEED): void {
    const b = this.body;
    if (this.wait > 0) {
      this.wait -= dt;
      b.speed = 0;
      return;
    }
    let leg = this.legs[this.li];
    if (!leg) {
      b.speed = 0;
      this.settleY(dt);
      return;
    }
    let move = (this.speedOverride ?? speeds[leg.mode]) * dt, moved = 0;
    while (move > 0 && leg) {
      const target: WorldPoint | undefined = leg.pts[this.si + 1];
      if (!target) {
        this.li++;
        this.si = 0;
        const next: Leg | undefined = this.legs[this.li];
        if (next) {
          if (b.setMode(next.mode)) { this.wait = MODE_SWITCH_WAIT; break; }
          leg = next;
          continue;
        }
        this.legs = [];
        leg = undefined;
        const cb = this.onArrive;
        if (cb) cb();
        break;
      }
      const dx = target.x - b.x, dz = target.z - b.z, d = Math.hypot(dx, dz);
      if (d > 0.001) b.targetYaw = Math.atan2(dx, dz);
      if (d <= move) {
        b.x = target.x;
        b.z = target.z;
        move -= d;
        moved += d;
        this.si++;
      } else {
        b.x += (dx / d) * move;
        b.z += (dz / d) * move;
        moved += move;
        move = 0;
      }
    }
    b.speed = dt > 0 ? moved / dt : 0;
    const cl = this.legs[this.li];
    if (cl && cl.mode === 'plane') {
      const p0 = cl.pts[0]!, p1 = cl.pts[cl.pts.length - 1]!;
      const L = dist(p0, p1) || 1, t = clamp(Math.hypot(b.x - p0.x, b.z - p0.z) / L, 0, 1);
      b.y = this.groundY + planeAltitude(t, L);
      b.planePitch = -0.28 * Math.cos(Math.PI * t);
    } else this.settleY(dt);
  }

  private settleY(dt: number): void {
    const b = this.body;
    b.planePitch = 0;
    if (Math.abs(b.y - this.groundY) > 0.001) b.y += (this.groundY - b.y) * Math.min(1, dt * 8);
    else b.y = this.groundY;
  }

  /** Remaining distance per leg from the current position (prototype `remainingByLeg`). */
  remainingByLeg(): LegRemaining[] {
    const out: LegRemaining[] = [];
    const b = this.body;
    for (let li = this.li; li < this.legs.length; li++) {
      const leg = this.legs[li]!, pts = leg.pts;
      let d = 0;
      if (li === this.li) {
        const nx = pts[this.si + 1];
        if (nx) {
          d += Math.hypot(nx.x - b.x, nx.z - b.z);
          for (let k = this.si + 1; k < pts.length - 1; k++) d += dist(pts[k]!, pts[k + 1]!);
        }
      } else d = pathLength(pts);
      out.push({ mode: leg.mode, d });
    }
    return out;
  }
}
