/**
 * Travel: `travel` / `cancelTravel` commands, `travel:start|progress|arrive|
 * cancel` events, the on-map route overlay with destination pin (prototype
 * `drawRoute`), and the full `route` request (same planner as travel).
 *
 * @module
 */

import type {
  EngineEvent,
  LngLat,
  Projection,
  RouteLeg,
  RouteResult,
  TravelMode,
} from '@diorama/protocol';
import { BoxGeometry, ConeGeometry, Group, Mesh, MeshBasicMaterial, RingGeometry, SphereGeometry, type Material } from 'three';
import type { ThrottledTopic } from '../bridge/subscriptions.js';
import { ACCENT, type MaterialFactory } from '../theme/materials.js';
import type { WorldModel } from '../world/model.js';
import type { Character } from './characters.js';
import { etaSeconds, KMH, pathLength, planLegs, type Leg } from './follower.js';

/** Plans a route result for the `route` request. */
export function routeResult(world: WorldModel, proj: Projection, from: LngLat, to: LngLat, modes: readonly TravelMode[]): RouteResult {
  const legs = planLegs(world, proj.toWorld(from), proj.toWorld(to), modes);
  const out: RouteLeg[] = legs.map((l) => ({ mode: l.mode, meters: proj.unitsToMeters(pathLength(l.pts)), path: l.pts.map((p) => proj.toLngLat(p)) }));
  const meters = out.reduce((a, l) => a + l.meters, 0);
  return { legs: out, meters, etaSeconds: out.reduce((a, l) => a + etaSeconds(l.meters, l.mode, KMH), 0) };
}

const ROUTE_COLORS: Readonly<Record<TravelMode, [number, number]>> = { walk: [ACCENT, 1], bike: [0x12a38a, 1], car: [0xff7a59, 1], plane: [0x4da3ff, 0.7], subway: [0x2e9e6b, 0.85] };

/** Route line and destination pin for one trip. */
export class RouteOverlay {
  readonly group = new Group();
  private readonly pin = new Group();
  private mats = new Map<TravelMode, MeshBasicMaterial>();
  private pinMats: Material[] = [];

  constructor() {
    this.group.name = 'route';
    this.pin.visible = false;
    this.group.add(this.pin);
  }

  draw(legs: readonly Leg[], groundY: number, mats: MaterialFactory): void {
    this.clearLines();
    const lines = new Group();
    lines.name = 'lines';
    for (const leg of legs) {
      const m = this.mat(leg.mode);
      for (let i = 0; i < leg.pts.length - 1; i++) {
        const a = leg.pts[i]!, b = leg.pts[i + 1]!, len = Math.hypot(b.x - a.x, b.z - a.z);
        if (len < 0.01) continue;
        const mesh = new Mesh(new BoxGeometry(0.5, 0.04, len + 0.5), m);
        mesh.position.set((a.x + b.x) / 2, groundY + 0.02, (a.z + b.z) / 2);
        mesh.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
        mesh.renderOrder = 5;
        lines.add(mesh);
      }
      if (leg.mode === 'subway') {
        for (const p of [leg.pts[0]!, leg.pts[leg.pts.length - 1]!]) {
          const ring = new Mesh(new RingGeometry(0.7, 1.05, 32).rotateX(-Math.PI / 2), m);
          ring.position.set(p.x, groundY + 0.06, p.z);
          lines.add(ring);
        }
      }
    }
    lines.traverse((o) => { o.raycast = () => {}; });
    this.group.add(lines);
    const last = legs[legs.length - 1];
    const end = last?.pts[last.pts.length - 1];
    if (end) {
      if (!this.pin.children.length) this.buildPin(mats);
      this.pin.position.set(end.x, groundY - 0.05, end.z);
      this.pin.visible = true;
    }
  }

  step(t: number, reduceMotion: boolean): void {
    if (this.pin.visible && this.pin.children[0]) this.pin.children[0].position.y = reduceMotion ? 0 : Math.abs(Math.sin(t * 3)) * 0.3;
  }

  clear(): void {
    this.clearLines();
    this.pin.visible = false;
  }

  dispose(): void {
    this.clear();
    for (const m of this.mats.values()) m.dispose();
    this.mats.clear();
    this.pin.traverse((o) => { const m = o as Mesh; if (m.isMesh) m.geometry.dispose(); });
    for (const m of this.pinMats) m.dispose();
  }

  private mat(mode: TravelMode): MeshBasicMaterial {
    let m = this.mats.get(mode);
    if (!m) {
      const [color, opacity] = ROUTE_COLORS[mode];
      m = new MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
      this.mats.set(mode, m);
    }
    return m;
  }

  private buildPin(mats: MaterialFactory): void {
    const bob = new Group();
    const pm = mats.make(ACCENT, { roughness: 0.5 });
    const white = new MeshBasicMaterial({ color: 0xffffff });
    this.pinMats.push(white);
    const cone = new Mesh(new ConeGeometry(0.34, 0.95, 16).rotateX(Math.PI).translate(0, 0.75, 0), pm);
    const head = new Mesh(new SphereGeometry(0.42, 16, 12).translate(0, 1.45, 0), pm);
    const dot = new Mesh(new SphereGeometry(0.15, 10, 8).translate(0, 1.5, 0.36), white);
    for (const m of [cone, head, dot]) { m.castShadow = true; m.raycast = () => {}; bob.add(m); }
    this.pin.add(bob);
  }

  private clearLines(): void {
    const lines = this.group.getObjectByName('lines');
    if (!lines) return;
    this.group.remove(lines);
    lines.traverse((o) => { const m = o as Mesh; if (m.isMesh) m.geometry.dispose(); });
  }
}

interface Trip {
  requestId: string;
  character: Character;
  legs: Leg[];
  overlay: RouteOverlay | null;
}

export interface TravelDeps {
  world(): WorldModel | null;
  projection(): Projection;
  materials: MaterialFactory;
  emit(event: EngineEvent): void;
  /** Group receiving route overlays. */
  overlayParent: Group;
  groundY(): number;
}

/** Runs trips for characters. */
export class TravelManager {
  private trips = new Map<string, Trip>();

  constructor(private readonly deps: TravelDeps) {}

  isTraveling(characterId: string): boolean {
    return this.trips.has(characterId);
  }

  /** Starts a trip; a running trip of the character is cancelled first. */
  start(requestId: string, ch: Character, to: LngLat, modes: readonly TravelMode[]): Leg[] {
    const world = this.deps.world();
    if (!world) throw new Error('no world loaded');
    const proj = this.deps.projection();
    this.cancel(ch.id);
    const legs = planLegs(world, { x: ch.x, z: ch.z }, proj.toWorld(to), modes);
    const overlay = ch.spec.isPlayer ? new RouteOverlay() : null;
    const trip: Trip = { requestId, character: ch, legs, overlay };
    this.trips.set(ch.id, trip);
    this.deps.emit({ type: 'travel:start', requestId, characterId: ch.id, legs: legs.map((l) => ({ mode: l.mode, meters: proj.unitsToMeters(pathLength(l.pts)) })) });
    if (!legs.length) {
      this.finish(trip);
      return legs;
    }
    if (overlay) {
      overlay.draw(legs, this.deps.groundY(), this.deps.materials);
      this.deps.overlayParent.add(overlay.group);
    }
    ch.follower.onArrive = () => { if (this.trips.get(ch.id) === trip) this.finish(trip); };
    ch.follower.setTrip(legs.map((l) => ({ ...l, pts: l.pts.map((p) => ({ ...p })) })));
    return legs;
  }

  /** Cancels the character's trip; returns whether one was running. */
  cancel(characterId: string): boolean {
    const trip = this.trips.get(characterId);
    if (!trip) return false;
    this.trips.delete(characterId);
    trip.character.follower.onArrive = null;
    trip.character.follower.setTrip([]);
    this.dropOverlay(trip);
    this.deps.emit({ type: 'travel:cancel', requestId: trip.requestId, characterId });
    return true;
  }

  cancelAll(): void {
    for (const id of [...this.trips.keys()]) this.cancel(id);
  }

  /** Emits throttled `travel:progress` events. */
  progress(topic: ThrottledTopic, now: number): void {
    if (!topic.active) return;
    const proj = this.deps.projection();
    for (const trip of this.trips.values()) {
      const ch = trip.character;
      if (!topic.wants(ch.id) || !topic.due(ch.id, now)) continue;
      const rem = ch.follower.remainingByLeg();
      const remainingMeters = proj.unitsToMeters(rem.reduce((a, r) => a + r.d, 0));
      const eta = rem.reduce((a, r) => a + etaSeconds(proj.unitsToMeters(r.d), r.mode, KMH), 0);
      const mode = ch.follower.mode ?? trip.legs[trip.legs.length - 1]?.mode ?? 'walk';
      this.deps.emit({ type: 'travel:progress', requestId: trip.requestId, characterId: ch.id, remainingMeters, etaSeconds: eta, mode });
    }
  }

  step(t: number, reduceMotion: boolean): void {
    for (const trip of this.trips.values()) trip.overlay?.step(t, reduceMotion);
  }

  dispose(): void {
    for (const trip of this.trips.values()) this.dropOverlay(trip);
    this.trips.clear();
  }

  private finish(trip: Trip): void {
    this.trips.delete(trip.character.id);
    trip.character.follower.onArrive = null;
    this.dropOverlay(trip);
    this.deps.emit({ type: 'travel:arrive', requestId: trip.requestId, characterId: trip.character.id });
  }

  private dropOverlay(trip: Trip): void {
    if (!trip.overlay) return;
    this.deps.overlayParent.remove(trip.overlay.group);
    trip.overlay.dispose();
    trip.overlay = null;
  }
}
