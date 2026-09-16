/**
 * Zoom-out behaviour controller (prototype `stepMap` + `buildMapOverlay`).
 *
 * - `none`: no change.
 * - `keepGameView` (favoured): buildings keep full height and colors; fog and
 *   shadow ranges extend with distance and small street clutter is hidden.
 * - `mapColors`: a flat road/landuse color overlay fades in and buildings
 *   shrink to 40% height.
 *
 * @module
 */

import { Group, Mesh, type Fog, type MeshBasicMaterial } from 'three';
import type { RoadClass, ZoomOutBehavior } from '@maprama/protocol';
import { clamp, smooth01 } from '../util/math.js';
import { ROAD_W } from '../world/graph.js';
import type { WorldModel } from '../world/model.js';
import type { MaterialFactory } from '../theme/materials.js';
import type { RenderParams } from '../theme/params.js';
import { discsGeo, polyGeo, quadsGeo, ribbonGeo, type Disc, type Quad } from './geometry.js';
import { clearGroup, noRaycast } from './parts.js';

/** Distance from the zoom-out target below which the easing snaps onto it (and stops asking for frames). */
const SNAP = 0.0005;

export const MAP_COLORS ={ arterial: 0xf7c45c, casing: 0xd99a32, local: 0xffffff, alley: 0xf3f0ea, ground: 0xeeeae2, park: 0xc4e2b2, water: 0x9ccbeb };

export interface ZoomOutTargets {
  fog: Fog;
  shadowCamera: { left: number; right: number; top: number; bottom: number; far: number; updateProjectionMatrix(): void };
  clutter: { visible: boolean };
  setHazeFade(t: number, mapColors: boolean): void;
}

/** Pure zoom factor: 0 below 55 world units, 1 at 110+, smoothstepped. */
export function zoomOutTarget(behavior: ZoomOutBehavior, distance: number): number {
  if (behavior === 'none') return 0;
  return smooth01(clamp((distance - 55) / 55, 0, 1));
}

export class ZoomOutController {
  readonly mapGroup = new Group();
  /** Smoothed 0..1 zoom-out factor. */
  t = 0;
  /** Building height multiplier (1 unless `mapColors`). */
  scaleY = 1;
  /** True while `t` is still easing toward its target (see the on-demand render loop). */
  animating = false;
  private applied = -1;
  private mode: ZoomOutBehavior | null = null;
  private mapMats: MeshBasicMaterial[] = [];

  constructor() {
    this.mapGroup.name = 'map-overlay';
  }

  /** Builds the flat map-colors overlay for a world. */
  buildOverlay(world: WorldModel, mats: MaterialFactory): void {
    clearGroup(this.mapGroup);
    for (const m of this.mapMats) m.dispose();
    this.mapMats = [];
    const mk = (c: number): MeshBasicMaterial => {
      const m = mats.basic({ color: c, transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
      m.visible = false;
      this.mapMats.push(m);
      return m;
    };
    const add = (geo: Mesh['geometry'], m: MeshBasicMaterial, order: number): void => {
      const mesh = new Mesh(geo, m);
      mesh.renderOrder = order;
      mesh.raycast = noRaycast;
      this.mapGroup.add(mesh);
    };
    const gm = mk(MAP_COLORS.ground);
    for (const pad of world.pads) add(polyGeo(pad, 0.015), gm, 1);
    const wmat = mk(MAP_COLORS.water);
    for (const r of world.waterRibbons) add(ribbonGeo(r.pts, r.width, 0.1), wmat, 2);
    for (const w of world.water) add(polyGeo(w, 0.1), wmat, 2);
    const pm = mk(MAP_COLORS.park);
    for (const p of world.parks) add(polyGeo(p.poly, 0.1), pm, 2);
    const G = world.graph;
    const q: Record<RoadClass, Quad[]> = { arterial: [], local: [], alley: [] };
    const dsc: Record<RoadClass, Disc[]> = { arterial: [], local: [], alley: [] };
    const cas: Quad[] = [];
    for (const e of G.edges) {
      const A = G.nodes[e.a]!, B = G.nodes[e.b]!, w = ROAD_W[e.cls] * 1.1;
      q[e.cls].push([A.x, A.z, B.x, B.z, w]);
      if (e.cls === 'arterial') cas.push([A.x, A.z, B.x, B.z, w + 0.7]);
    }
    G.nodes.forEach((n, i) => {
      const adj = G.adj[i]!;
      if (!adj.length) return;
      const cls = adj.map((ei) => G.edges[ei]!.cls).sort((a, b) => ROAD_W[b] - ROAD_W[a])[0]!;
      dsc[cls].push([n.x, n.z, ROAD_W[cls] * 0.55]);
    });
    add(quadsGeo(cas, 0.11), mk(MAP_COLORS.casing), 3);
    (['alley', 'local', 'arterial'] as const).forEach((cls, k) => {
      const m = mk(MAP_COLORS[cls]);
      add(quadsGeo(q[cls], 0.112 + k * 0.002), m, 4 + k);
      add(discsGeo(dsc[cls], 0.112 + k * 0.002), m, 4 + k);
    });
  }

  /** Forces re-application on the next update (after a theme change). */
  invalidate(): void {
    this.applied = -1;
  }

  update(dt: number, distance: number, params: RenderParams, targets: ZoomOutTargets, reduceMotion: boolean): void {
    const behavior = params.zoomOut;
    const target = zoomOutTarget(behavior, distance);
    this.t += (target - this.t) * (reduceMotion ? 1 : Math.min(1, dt * 6));
    // The easing only approaches its target: snap so it terminates and the loop can go idle.
    if (Math.abs(target - this.t) < SNAP) this.t = target;
    this.animating = this.t !== target;
    const t = this.t, mt = behavior === 'mapColors' ? t : 0;
    // The last (sub-threshold) step still has to be applied, otherwise the settled state is stale.
    if (Math.abs(t - this.applied) > 0.003 || this.applied < 0 || this.mode !== behavior || (!this.animating && this.applied !== t)) {
      this.applied = t;
      this.mode = behavior;
      for (const m of this.mapMats) {
        m.opacity = mt * 0.92;
        m.visible = mt > 0.01;
      }
      this.scaleY = 1 - mt * 0.6;
      targets.fog.near = params.fog.near + t * 110;
      targets.fog.far = params.fog.far + t * 260;
      const ext = 48 + t * 95, sc = targets.shadowCamera;
      sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.far = 160 + t * 200;
      sc.updateProjectionMatrix();
      targets.clutter.visible = t < 0.5;
      targets.setHazeFade(t, mt > 0);
    }
  }
}
