/**
 * Request handlers (`project`, `unproject`, `snapToRoad`, `snapToBuilding`,
 * `route`) built on small service interfaces so they can be tested without
 * WebGL.
 *
 * @module
 */

import {
  DEFAULT_SNAP_TO_BUILDING_METERS,
  createProjection,
  type LngLat,
  type Projection,
  type RequestMethod,
  type RouteLeg,
  type RouteResult,
  type TravelMode,
} from '@maprama/protocol';
import type { RequestHandler } from '../bridge/dispatcher.js';
import { EngineError } from '../bridge/dispatcher.js';
import { snapToBuilding as snapBuilding } from '../labels/anchor.js';
import { MARKER_SNAP_INSET_METERS as SNAP_INSET_METERS } from '../labels/markers.js';
import { polylineLength, route, snap } from '../world/graph.js';
import { PROCEDURAL_ORIGIN, type WorldModel } from '../world/model.js';

/**
 * Default travel speeds in km/h used for part-1 route ETAs (prototype `KMH`).
 * Part 2 owns travel and may replace the `route` handler.
 */
export const DEFAULT_KMH: Readonly<Record<TravelMode, number>> = Object.freeze({ walk: 4.8, bike: 15, car: 30, plane: 180, subway: 60 });

/** Screen/world view services required by the handlers. */
export interface ViewService {
  worldToScreen(x: number, y: number, z: number): { x: number; y: number; visible: boolean };
  screenToGround(px: number, py: number): { x: number; z: number } | null;
}

export interface RequestServices {
  world(): WorldModel | null;
  view: ViewService;
  /**
   * Current roof Y of a building in world units, `null` when it is not drawn
   * (filtered out, or a world that has no geometry yet). Required by
   * `snapToBuilding`; without it the request answers `null`.
   */
  roofY?(id: string): number | null;
  /** Y of the ground in world units. Defaults to 0. */
  groundY?(): number;
}

/** Projection for a world (procedural worlds use {@link PROCEDURAL_ORIGIN}). */
export function projectionFor(world: WorldModel | null): Projection {
  return world ? createProjection({ origin: world.origin, unitMeters: world.unitMeters }) : createProjection({ origin: PROCEDURAL_ORIGIN, unitMeters: 8 });
}

const requireWorld = (s: RequestServices): WorldModel => {
  const w = s.world();
  if (!w) throw new EngineError('not_ready', 'no world loaded (send init first)');
  return w;
};

/** Plans a route over the road graph (part-1 approximation of travel legs). */
export function planRoute(world: WorldModel, from: { x: number; z: number }, to: { x: number; z: number }, modes: TravelMode[], kmh: Readonly<Record<TravelMode, number>> = DEFAULT_KMH): { legs: { mode: TravelMode; pts: { x: number; z: number }[] }[] } {
  const primary: TravelMode = modes.find((m) => m !== 'walk') ?? 'walk';
  void kmh;
  if (primary === 'plane') return { legs: [{ mode: 'plane', pts: [from, to] }] };
  if (primary === 'subway' && world.stations.length >= 2) {
    const nearest = (p: { x: number; z: number }) => world.stations.reduce((a, s) => (Math.hypot(s.x - p.x, s.z - p.z) < Math.hypot(a.x - p.x, a.z - p.z) ? s : a));
    const sa = nearest(from), sb = nearest(to);
    if (sa !== sb) {
      const walkTo = (a: { x: number; z: number }, b: { x: number; z: number }) => roadPath(world, a, b);
      return { legs: [{ mode: 'walk', pts: walkTo(from, sa) }, { mode: 'subway', pts: [{ x: sa.x, z: sa.z }, { x: sb.x, z: sb.z }] }, { mode: 'walk', pts: walkTo(sb, to) }] };
    }
  }
  const path = roadPath(world, from, to);
  if (modes.length === 1 || primary === 'walk') return { legs: [{ mode: primary, pts: path }] };
  // walk to the road, ride along it, walk from the road
  const inner = path.slice(1, -1);
  const legs: { mode: TravelMode; pts: { x: number; z: number }[] }[] = [];
  if (inner.length >= 2) {
    legs.push({ mode: 'walk', pts: [path[0]!, inner[0]!] });
    legs.push({ mode: primary, pts: inner });
    legs.push({ mode: 'walk', pts: [inner[inner.length - 1]!, path[path.length - 1]!] });
  } else legs.push({ mode: primary, pts: path });
  return { legs };
}

function roadPath(world: WorldModel, a: { x: number; z: number }, b: { x: number; z: number }): { x: number; z: number }[] {
  const sa = snap(world.graph, a.x, a.z), sb = snap(world.graph, b.x, b.z);
  if (!sa || !sb) return [a, b];
  const pts = route(world.graph, sa, sb);
  const out = [{ x: a.x, z: a.z }, ...pts, { x: b.x, z: b.z }];
  return out.filter((p, i) => i === 0 || Math.hypot(p.x - out[i - 1]!.x, p.z - out[i - 1]!.z) > 0.01);
}

/**
 * The request methods answered from world + view services alone. `fitBounds`
 * and `focusOn` are not among them: they move the camera, so the engine owns
 * them.
 */
export type RequestHandlers = { [M in Exclude<RequestMethod, 'fitBounds' | 'focusOn'>]: RequestHandler<M> };

export function createRequestHandlers(s: RequestServices): RequestHandlers {
  return {
    project: ({ coordinate }) => {
      const p = projectionFor(s.world()).toWorld(coordinate);
      return s.view.worldToScreen(p.x, 0, p.z);
    },
    unproject: ({ x, y }) => {
      const hit = s.view.screenToGround(x, y);
      return { coordinate: hit ? projectionFor(s.world()).toLngLat(hit) : null };
    },
    snapToRoad: ({ coordinate, maxDistanceMeters }) => {
      const w = requireWorld(s);
      const proj = projectionFor(w);
      const p = proj.toWorld(coordinate);
      const sn = snap(w.graph, p.x, p.z);
      if (!sn) return null;
      const meters = proj.unitsToMeters(sn.dist);
      if (maxDistanceMeters !== undefined && meters > maxDistanceMeters) return null;
      return { coordinate: proj.toLngLat({ x: sn.x, z: sn.z }), roadId: w.graph.edges[sn.e]!.roadId, distanceMeters: meters };
    },
    snapToBuilding: ({ coordinate, maxDistanceMeters }) => {
      const w = requireWorld(s);
      if (!s.roofY) return null;
      const proj = projectionFor(w);
      const p = proj.toWorld(coordinate);
      const ground = s.groundY?.() ?? 0;
      const max = maxDistanceMeters ?? DEFAULT_SNAP_TO_BUILDING_METERS;
      const hit = snapBuilding(w.buildings, p.x, p.z, proj.metersToUnits(max), proj.metersToUnits(SNAP_INSET_METERS));
      if (!hit) return null;
      const roof = s.roofY(hit.building.id);
      if (roof === null) return null;
      const coord = proj.toLngLat({ x: hit.x, z: hit.z });
      return {
        coordinate: coord,
        buildingId: hit.building.id,
        heightMeters: Math.max(0, proj.unitsToMeters(roof - ground)),
        roofCoordinate: { ...coord },
        distanceMeters: proj.unitsToMeters(hit.distance),
        inside: hit.inside,
      };
    },
    route: ({ from, to, modes }) => {
      const w = requireWorld(s);
      const proj = projectionFor(w);
      const plan = planRoute(w, proj.toWorld(from), proj.toWorld(to), modes);
      const legs: RouteLeg[] = plan.legs.map((l) => ({ mode: l.mode, meters: proj.unitsToMeters(polylineLength(l.pts)), path: l.pts.map((p): LngLat => proj.toLngLat(p)) }));
      const meters = legs.reduce((a, l) => a + l.meters, 0);
      const etaSeconds = legs.reduce((a, l) => a + l.meters / (DEFAULT_KMH[l.mode] / 3.6), 0);
      const result: RouteResult = { legs, meters, etaSeconds };
      return result;
    },
  };
}
