/**
 * Render context and part helpers shared by the world renderers (prototype
 * `addPart`, `outlineScale`, `clearGroup`, `tree`).
 *
 * @module
 */

import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  Mesh,
  Vector3,
  type BufferGeometry,
  type Material,
  type Object3D,
  Group,
} from 'three';
import { LAYER_OCCLUDER } from '../core/renderer.js';
import type { MaterialFactory } from '../theme/materials.js';
import type { RenderParams } from '../theme/params.js';
import type { TextureSet } from '../theme/textures.js';
import type { WorldModel } from '../world/model.js';

/** Everything a renderer needs to build meshes for the current theme and world. */
export interface RenderContext {
  params: RenderParams;
  mats: MaterialFactory;
  tex: TextureSet;
  world: WorldModel;
}

export interface PartOptions {
  /** Cast shadows (default true). */
  cast?: boolean;
  receive?: boolean;
  /** Occludes silhouettes (layer 1). */
  occluder?: boolean;
  /** Outline thickness; 0 disables. Only drawn when the theme has outlines. */
  outline?: number;
  ink?: Material;
}

export const noRaycast = (): void => {};

const va = new Vector3(), vb = new Vector3();

export function outlineScale(ol: Object3D, geo: BufferGeometry, s: number): void {
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const size = bb.getSize(va), c = bb.getCenter(vb);
  const f = (n: number): number => (n < 1e-3 ? 1 : (n + 2 * s) / n);
  const sx = f(size.x), sy = f(size.y), sz = f(size.z);
  ol.scale.set(sx, sy, sz);
  ol.position.x += c.x * (1 - sx);
  ol.position.y += c.y * (1 - sy);
  ol.position.z += c.z * (1 - sz);
}

export function addPart(ctx: RenderContext, parent: Object3D, geo: BufferGeometry, mat: Material | Material[], o: PartOptions = {}): Mesh {
  const m = new Mesh(geo, mat);
  m.castShadow = o.cast !== false;
  m.receiveShadow = !!o.receive;
  if (o.occluder) m.layers.enable(LAYER_OCCLUDER);
  parent.add(m);
  if (o.outline !== 0 && ctx.params.outline) {
    const ol = new Mesh(geo, o.ink ?? ctx.mats.ink);
    outlineScale(ol, geo, o.outline ?? 0.06);
    ol.raycast = noRaycast;
    ol.castShadow = false;
    parent.add(ol);
  }
  return m;
}

/** Removes and disposes children (geometries flagged `userData.shared` are kept). */
export function clearGroup(g: Object3D): void {
  while (g.children.length) {
    const c = g.children.pop()!;
    c.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.geometry && !mesh.geometry.userData.shared) mesh.geometry.dispose();
    });
  }
}

const shared = <T extends BufferGeometry>(g: T): T => {
  g.userData.shared = true;
  return g;
};

let SHARED: {
  trunk: BufferGeometry;
  crown: BufferGeometry;
  cone: BufferGeometry;
  carBody: BufferGeometry;
  carCab: BufferGeometry;
} | null = null;

/** Geometries shared across rebuilds (never disposed by {@link clearGroup}). */
export function sharedGeometries(): NonNullable<typeof SHARED> {
  if (!SHARED) {
    SHARED = {
      trunk: shared(new CylinderGeometry(0.1, 0.14, 0.6, 6).translate(0, 0.3, 0)),
      crown: shared(new IcosahedronGeometry(0.62, 1).translate(0, 1.05, 0)),
      cone: shared(new ConeGeometry(0.62, 1.5, 7).translate(0, 1.25, 0)),
      carBody: shared(new BoxGeometry(0.54, 0.22, 1.3).translate(0, 0.2, 0)),
      carCab: shared(new BoxGeometry(0.48, 0.2, 0.68).translate(0, 0.41, -0.06)),
    };
  }
  return SHARED;
}

export const CAR_COLORS = [0xe9e7e3, 0x2b2e33, 0x8a9097, 0xb23a33, 0x2f4e73, 0xc9c2b5, 0x4e6b5a];

/** A stylized tree (prototype `tree`). */
export function tree(ctx: RenderContext, parent: Object3D, x: number, y: number, z: number, s: number, r: () => number, noOutline = false): Group {
  const G = sharedGeometries();
  const g = new Group();
  g.position.set(x, y, z);
  g.scale.setScalar(s);
  addPart(ctx, g, G.trunk, ctx.mats.themed('trunk'), { outline: noOutline ? 0 : 0.04 });
  const round = r() < 0.6 || ctx.params.facadeSet === 'soft';
  addPart(ctx, g, round ? G.crown : G.cone, r() < 0.5 ? ctx.mats.themed('leafA', { roughness: 1 }) : ctx.mats.themed('leafB', { roughness: 1 }), { outline: noOutline ? 0 : 0.05 });
  parent.add(g);
  return g;
}
