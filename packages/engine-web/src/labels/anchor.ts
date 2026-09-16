/**
 * Where a pin, a label or an info card stands in the world: which building
 * carries it, and how high above the ground its foot sits.
 *
 * One module because three callers need exactly the same answer and must not
 * drift apart: `<InfoCard>` (`anchor: 'ground' | 'roof' | 'auto'`),
 * `<MarkerLayer>` (`anchorHeight`, `snapToBuilding`) and the `snapToBuilding`
 * request. The lookup is a linear scan over the world's footprints, so it runs
 * **once per command**, never per frame; only `baseY` is refreshed each frame,
 * because the zoom-out view squashes the buildings and a roof anchor has to
 * stay on the roof.
 *
 * ## Depth rule for roof anchors
 *
 * Markers, labels and cards are DOM elements over the canvas, so they are
 * **never occluded by the buildings** — a roof-anchored pin stays visible even
 * when the building it stands on is in front of another one. That is deliberate
 * and matches the label layer's existing behaviour: the only thing that can
 * hide a pin is the collision pass, and `inFront()` hides what is behind the
 * camera. Anchoring to the roof therefore does not add a depth-test problem; it
 * removes one, because a ground pin inside a tall building projects to a screen
 * point the building visually covers, which reads as "the pin is in the wrong
 * place".
 *
 * @module
 */

import type { Vec2 } from '@maprama/protocol';
import { pointInPolygon } from '../world/polygon.js';

/** The minimum a building footprint must be for a snap to target it, in world units. */
const MIN_SNAP_RING = 3;

/** A building as the anchor lookup sees it. */
export interface AnchorBuilding {
  id: string;
  footprint: readonly Vec2[];
}

/** Anchor of something standing in the world, in world units. */
export interface WorldAnchor {
  x: number;
  z: number;
  /** Y of the foot: the ground, or the building's roof. */
  baseY: number;
  /** Height above `baseY`, in world units. */
  height: number;
  /**
   * The building the anchor stands on. The lookup runs once; `baseY` is
   * refreshed from this id every frame.
   */
  buildingId?: string;
  /** How far `x`/`z` moved onto the building, in world units. Absent when it did not move. */
  snapDistance?: number;
}

/**
 * Squared distance from `(x, z)` to a footprint's outline, and the nearest
 * point on it. Does **not** special-case containment — callers test that first.
 */
export function nearestOnRing(x: number, z: number, ring: readonly Vec2[]): { x: number; z: number; d2: number } {
  let bx = ring[0]![0], bz = ring[0]![1], best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i]!;
    const [cx, cz] = ring[(i + 1) % ring.length]!;
    const dx = cx - ax, dz = cz - az;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
    const px = ax + t * dx, pz = az + t * dz;
    const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
    if (d2 < best) { best = d2; bx = px; bz = pz; }
  }
  return { x: bx, z: bz, d2: best };
}

/** Average of a ring's vertices — cheap, and always inside a convex-ish footprint. */
function ringMean(ring: readonly Vec2[]): { x: number; z: number } {
  let x = 0, z = 0;
  for (const p of ring) { x += p[0]; z += p[1]; }
  return { x: x / ring.length, z: z / ring.length };
}

/** The first building whose footprint contains `(x, z)`, or `null`. */
export function buildingAt(buildings: readonly AnchorBuilding[], x: number, z: number): AnchorBuilding | null {
  for (const b of buildings) if (b.footprint.length >= MIN_SNAP_RING && pointInPolygon(x, z, b.footprint)) return b;
  return null;
}

/** A point moved onto a building, with how far it travelled. */
export interface BuildingSnap {
  building: AnchorBuilding;
  x: number;
  z: number;
  /** Distance from the input to the footprint outline, in world units. */
  distance: number;
  inside: boolean;
}

/**
 * The building at `(x, z)`, or the nearest one whose outline is within
 * `maxDistance` world units. A snapped point is pulled `inset` units past the
 * outline toward the footprint's mean vertex, so it lands *inside* the
 * building rather than exactly on its edge (where a rounding error would put
 * it back outside); if that overshoots a thin footprint the mean vertex itself
 * is used.
 *
 * Linear over the footprints — fine for a city-sized world at command rate, not
 * for a per-frame loop.
 */
export function snapToBuilding(
  buildings: readonly AnchorBuilding[],
  x: number,
  z: number,
  maxDistance: number,
  inset = 0,
): BuildingSnap | null {
  const hit = buildingAt(buildings, x, z);
  if (hit) return { building: hit, x, z, distance: 0, inside: true };
  if (!(maxDistance > 0)) return null;
  const max2 = maxDistance * maxDistance;
  let best: { b: AnchorBuilding; x: number; z: number; d2: number } | null = null;
  for (const b of buildings) {
    if (b.footprint.length < MIN_SNAP_RING) continue;
    const near = nearestOnRing(x, z, b.footprint);
    if (near.d2 > max2) continue;
    if (!best || near.d2 < best.d2) best = { b, x: near.x, z: near.z, d2: near.d2 };
  }
  if (!best) return null;
  const to = insetIntoRing(best.x, best.z, best.b.footprint, inset);
  return { building: best.b, x: to.x, z: to.z, distance: Math.sqrt(best.d2), inside: false };
}

/**
 * Walks a point on a footprint's outline `inset` units inward, toward the
 * ring's interior point, and keeps walking (in a few widening steps) until it
 * is genuinely inside — a concave footprint can put the first step back
 * outside. Falls back to the interior point itself.
 *
 * Mirrored by `attachPoisToBuildings` in `tools/osm/src/build.ts`; the two must
 * place a snapped point the same way, because a world built with the join and a
 * marker snapped at runtime should land in the same spot.
 */
export function insetIntoRing(x: number, z: number, ring: readonly Vec2[], inset: number): { x: number; z: number } {
  const m = interiorOf(ring);
  const dx = m.x - x, dz = m.z - z;
  const len = Math.hypot(dx, dz);
  if (!(inset > 0) || len <= 1e-9) return pointInPolygon(x, z, ring) ? { x, z } : { x: m.x, z: m.z };
  for (const t of [Math.min(inset, len) / len, 0.05, 0.15, 0.35, 0.6]) {
    const px = x + dx * t, pz = z + dz * t;
    if (pointInPolygon(px, pz, ring)) return { x: px, z: pz };
  }
  return { x: m.x, z: m.z };
}

/** The ring's mean vertex when that is inside it, otherwise a guaranteed interior point. */
function interiorOf(ring: readonly Vec2[]): { x: number; z: number } {
  const m = ringMean(ring);
  if (pointInPolygon(m.x, m.z, ring)) return m;
  // Widest horizontal span through the mean's z (same rule as `tools/osm`'s `interiorPoint`).
  const xs: number[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    if (a[1] > m.z !== b[1] > m.z) xs.push(a[0] + ((m.z - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
  }
  xs.sort((p, q) => p - q);
  let best = m, width = -1;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    const w = xs[i + 1]! - xs[i]!;
    if (w > width) { width = w; best = { x: (xs[i]! + xs[i + 1]!) / 2, z: m.z }; }
  }
  return best;
}

/** What {@link resolveWorldAnchor} needs to know about the scene. */
export interface AnchorContext {
  buildings: readonly AnchorBuilding[];
  /** Current roof Y of a building (`null` when it is not drawn). */
  roofY(id: string): number | null;
  /** Y of the ground. */
  groundY: number;
}

/** How high above the ground / roof the anchor's own foot sits. */
export interface AnchorRequest {
  x: number;
  z: number;
  /**
   * `ground`: never look for a building. `roof`: stand on the building at
   * `(x, z)`, the ground when there is none. `auto` behaves like `roof`.
   */
  mode: 'ground' | 'roof' | 'auto';
  /** Height above the foot, in world units. */
  height: number;
  /** Snap radius in world units; 0 disables snapping (containment still counts). */
  snapDistance?: number;
  /** How far past the outline a snapped point is pulled, in world units. */
  snapInset?: number;
}

/**
 * Resolves one anchor. Shared by the info cards, the markers and the
 * `snapToBuilding` request so the three never disagree about which building a
 * coordinate belongs to.
 */
export function resolveWorldAnchor(ctx: AnchorContext, req: AnchorRequest): WorldAnchor {
  const anchor: WorldAnchor = { x: req.x, z: req.z, baseY: ctx.groundY, height: req.height };
  if (req.mode === 'ground') return anchor;
  const snap = snapToBuilding(ctx.buildings, req.x, req.z, req.snapDistance ?? 0, req.snapInset ?? 0);
  if (!snap) return anchor;
  const y = ctx.roofY(snap.building.id);
  if (y === null) return anchor;
  anchor.x = snap.x;
  anchor.z = snap.z;
  anchor.baseY = y;
  anchor.buildingId = snap.building.id;
  if (!snap.inside) anchor.snapDistance = snap.distance;
  return anchor;
}
