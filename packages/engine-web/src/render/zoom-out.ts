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

/** Change in the zoom-out factor below which nothing is re-applied (and no more frames are asked for). */
const APPLY_EPS = 0.003;

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

/**
 * Camera distance (world units) the fog and shadow ranges below are calibrated
 * for — the default `DIST_MAX`. The zoom-out factor is already 1 from 110
 * units, so past this point nothing else would grow with the camera.
 */
export const RANGE_REF = 150;

/**
 * How far the fog and shadow ranges are stretched at a camera distance.
 *
 * 1 at and below {@link RANGE_REF}, so every view an app could reach before
 * `maxDistanceMeters` existed looks exactly as it did; `distance / RANGE_REF`
 * beyond it, which keeps the fog fading at the same place on screen at 3 km as
 * it does at 1.2 km. Without it, a camera 416 units out sits *behind* a fog far
 * plane of 410 units and the screen is a flat wall of fog.
 */
export function rangeScale(distance: number): number {
  return Math.max(1, distance / RANGE_REF);
}

/** Change in {@link rangeScale} below which the look is not re-applied. */
const SCALE_EPS = 1e-3;

export class ZoomOutController {
  readonly mapGroup = new Group();
  /** Smoothed 0..1 zoom-out factor. */
  t = 0;
  /** Building height multiplier (1 unless `mapColors`). */
  scaleY = 1;
  /** True while `t` is still easing toward its target (see the on-demand render loop). */
  animating = false;
  private applied = -1;
  private appliedScale = -1;
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
    this.appliedScale = -1;
  }

  update(dt: number, distance: number, params: RenderParams, targets: ZoomOutTargets, reduceMotion: boolean): void {
    const behavior = params.zoomOut;
    const target = zoomOutTarget(behavior, distance);
    this.t += (target - this.t) * (reduceMotion ? 1 : Math.min(1, dt * 6));
    // The easing only approaches its target and never reaches it, so "still animating" is decided by
    // the same epsilon that decides whether anything is re-applied below: once `t` is within it, the
    // rendered state stops changing and the loop may go idle. `t` itself is left alone — the native
    // engine reproduces this trajectory step for step (engine-native conformance suite).
    this.animating = Math.abs(target - this.t) > APPLY_EPS;
    const t = this.t, mt = behavior === 'mapColors' ? t : 0;
    // Beyond the reference distance the fog and shadow ranges are stretched with the camera, so the
    // look at 3 km is the look at 1.2 km. `k` is 1 below it, and the applied-value guard tracks it too.
    const k = rangeScale(distance);
    if (Math.abs(t - this.applied) > APPLY_EPS || Math.abs(k - this.appliedScale) > SCALE_EPS || this.applied < 0 || this.mode !== behavior) {
      this.applied = t;
      this.appliedScale = k;
      this.mode = behavior;
      for (const m of this.mapMats) {
        m.opacity = mt * 0.92;
        m.visible = mt > 0.01;
      }
      this.scaleY = 1 - mt * 0.6;
      targets.fog.near = (params.fog.near + t * 110) * k;
      targets.fog.far = (params.fog.far + t * 260) * k;
      const ext = (48 + t * 95) * k, sc = targets.shadowCamera;
      sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.far = (160 + t * 200) * k;
      sc.updateProjectionMatrix();
      targets.clutter.visible = t < 0.5;
      targets.setHazeFade(t, mt > 0);
    }
  }
}
