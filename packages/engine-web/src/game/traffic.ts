/**
 * Ambient traffic (prototype `initTraffic` / `stepTraffic`): cars driving the
 * non-alley road network, headlight glow at night. Shown when the theme's
 * `street.traffic` is on.
 *
 * @module
 */

import { AdditiveBlending, BoxGeometry, Group, Mesh, MeshBasicMaterial, PlaneGeometry, type Texture } from 'three';
import { CAR_COLORS, sharedGeometries } from '../render/parts.js';
import type { MaterialFactory } from '../theme/materials.js';
import { mulberry32 } from '../util/math.js';
import type { WorldModel } from '../world/model.js';

interface Car {
  g: Group;
  glow: Mesh;
  e: number;
  from: number;
  s: number;
  speed: number;
  yaw: number;
}

export class AmbientTraffic {
  readonly group = new Group();
  private cars: Car[] = [];
  private world: WorldModel | null = null;
  private owned: (MeshBasicMaterial | BoxGeometry | PlaneGeometry)[] = [];
  private rng = mulberry32(7);

  constructor() {
    this.group.name = 'traffic';
    this.group.visible = false;
  }

  /** Number of ambient cars built for the current world. */
  get count(): number {
    return this.cars.length;
  }

  /**
   * True while the cars are driving: they keep moving regardless of reduced
   * motion, so they need frames as long as the theme shows them.
   */
  get animating(): boolean {
    return this.group.visible && this.cars.length > 0;
  }

  build(world: WorldModel, mats: MaterialFactory, glowTex: Texture): void {
    this.clear();
    this.world = world;
    this.rng = mulberry32(7);
    const g0 = world.graph;
    const cands = g0.edges.map((_, i) => i).filter((i) => g0.edges[i]!.cls !== 'alley' && g0.edges[i]!.len > 0.5);
    if (!cands.length) return;
    const G = sharedGeometries();
    const lightGeo = new BoxGeometry(0.12, 0.05, 0.02), glowGeo = new PlaneGeometry(1.0, 1.8).rotateX(-Math.PI / 2);
    const headM = new MeshBasicMaterial({ color: 0xfff1d2 }), tailM = new MeshBasicMaterial({ color: 0xd02a22 });
    const glowM = new MeshBasicMaterial({ color: 0xffd9a0, map: glowTex, transparent: true, opacity: 0.55, blending: AdditiveBlending, depthWrite: false });
    this.owned.push(lightGeo, glowGeo, headM, tailM, glowM);
    const glass = mats.make(0x27313b, { roughness: 0.12, metalness: 0.4 });
    const count = world.kind === 'town' ? 16 : world.kind === 'grid' ? 12 : Math.min(16, Math.max(4, Math.round(cands.length / 8)));
    for (let k = 0; k < count; k++) {
      const g = new Group();
      const body = new Mesh(G.carBody, mats.make(CAR_COLORS[k % CAR_COLORS.length]!, { roughness: 0.3, metalness: 0.25 }));
      body.castShadow = true;
      const cab = new Mesh(G.carCab, glass);
      cab.castShadow = true;
      g.add(body, cab);
      for (const sx of [-0.17, 0.17]) {
        const hl = new Mesh(lightGeo, headM);
        hl.position.set(sx, 0.22, 0.66);
        const tl = new Mesh(lightGeo, tailM);
        tl.position.set(sx, 0.24, -0.66);
        g.add(hl, tl);
      }
      const glow = new Mesh(glowGeo, glowM);
      glow.position.set(0, 0.07, 1.4);
      glow.renderOrder = 2;
      g.add(glow);
      g.traverse((o) => { o.raycast = () => {}; });
      const ei = cands[Math.floor(this.rng() * cands.length)]!;
      this.cars.push({ g, glow, e: ei, from: g0.edges[ei]!.a, s: this.rng() * g0.edges[ei]!.len, speed: 4 + this.rng() * 2.5, yaw: 0 });
      this.group.add(g);
    }
  }

  step(dt: number, visible: boolean, night: boolean): void {
    this.group.visible = visible && this.cars.length > 0;
    const w = this.world;
    if (!visible || !w) return;
    const G = w.graph, y = w.kind === 'grid' ? 0.04 : w.kind === 'town' ? 0.09 : 0.08;
    for (const c of this.cars) {
      let e = G.edges[c.e]!;
      c.s += c.speed * dt;
      if (c.s >= e.len) {
        c.s -= e.len;
        const at = c.from === e.a ? e.b : e.a;
        const opts = G.adj[at]!.filter((i) => i !== c.e && G.edges[i]!.cls !== 'alley');
        if (opts.length) c.e = opts[Math.floor(this.rng() * opts.length)]!;
        c.from = at;
        e = G.edges[c.e]!;
        if (c.s > e.len) c.s = 0;
      }
      const A = G.nodes[c.from]!, B = G.nodes[c.from === e.a ? e.b : e.a]!;
      const len = e.len || 1, fx = (B.x - A.x) / len, fz = (B.z - A.z) / len, lat = e.cls === 'arterial' ? 0.7 : 0.3;
      const x = A.x + fx * c.s - fz * lat, z = A.z + fz * c.s + fx * lat;
      let dd = Math.atan2(fx, fz) - c.yaw;
      dd = Math.atan2(Math.sin(dd), Math.cos(dd));
      c.yaw += dd * Math.min(1, dt * 8);
      c.g.position.set(x, y, z);
      c.g.rotation.y = c.yaw;
      c.glow.visible = night;
    }
  }

  clear(): void {
    for (const c of this.cars) this.group.remove(c.g);
    this.cars = [];
    for (const o of this.owned) o.dispose();
    this.owned = [];
  }
}
