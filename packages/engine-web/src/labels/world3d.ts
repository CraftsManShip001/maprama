/**
 * 3D world labels (prototype `buildWorldLabels` / `stepWorldLabels`):
 * `ground` paints road and district names on the ground (road text turned to
 * stay readable from the camera) with POI pins; `sign` places street-name
 * signposts at named intersections, floating district boards and POI pins.
 *
 * @module
 */

import type { LabelContent, LabelContentMode } from '@maprama/protocol';
import {
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  type Material,
  type Texture,
} from 'three';
import { roundRectPath } from '../theme/textures.js';
import type { MaterialFactory } from '../theme/materials.js';
import { cssHexToNumber } from '../util/math.js';
import { ROAD_W } from '../world/graph.js';
import type { WorldModel } from '../world/model.js';
import { ICON_COLORS } from './icons.js';
import { resolveLabelContent, type LabelEntry } from './index.js';

interface TextOptions {
  size?: number;
  weight?: number;
  color?: string;
  bg?: string;
  radius?: number;
  spacing?: number;
  padX?: number;
  padY?: number;
}

const FONT = `'IBM Plex Sans KR','Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',sans-serif`;

export type WorldLabelKind = 'ground' | 'sign';

export class WorldLabels3D {
  readonly group = new Group();
  private textures: Texture[] = [];
  private mats: Material[] = [];
  private groundText: { m: Mesh; tx?: number; tz?: number; kind: 'road' | 'district' }[] = [];
  built = '';

  constructor(private readonly doc: Document) {
    this.group.name = 'world-labels';
  }

  build(kind: WorldLabelKind, entries: readonly LabelEntry[], world: WorldModel, mats: MaterialFactory, mode: LabelContentMode, content: Readonly<Record<string, LabelContent>>, groundY: number, key: string): void {
    this.clear();
    this.built = key;
    const title = (e: LabelEntry): string => resolveLabelContent(e, mode, content).title;
    const roadY = groundY + 0.03;
    const flatText = (tex: Texture, w: number, h: number, x: number, y: number, z: number): Mesh => {
      const mat = new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6 });
      this.mats.push(mat);
      const m = new Mesh(new PlaneGeometry(w, h).rotateX(-Math.PI / 2), mat);
      m.position.set(x, y, z);
      m.renderOrder = 7;
      m.raycast = () => {};
      this.group.add(m);
      return m;
    };
    if (kind === 'ground') {
      for (const e of entries) {
        if (e.kind === 'road') {
          const art = e.roadClass === 'arterial';
          const { tex, aspect } = this.textCanvas(title(e), { size: 64, weight: 600, color: art ? 'rgba(255,230,170,.98)' : 'rgba(255,255,255,.96)', spacing: 12, padX: 8, padY: 2 });
          const h = art ? 1.7 : 1.3;
          const gt: { m: Mesh; tx?: number; tz?: number; kind: 'road' } = { m: flatText(tex, h * aspect, h, e.x, roadY, e.z), kind: 'road' };
          if (e.tx !== undefined) gt.tx = e.tx;
          if (e.tz !== undefined) gt.tz = e.tz;
          this.groundText.push(gt);
        } else if (e.kind === 'district') {
          const water = !!e.water;
          const { tex, aspect } = this.textCanvas(title(e), { size: 120, weight: 700, color: water ? 'rgba(220,240,252,.9)' : 'rgba(34,38,50,.5)', spacing: 70, padX: 20, padY: 6 });
          const h = water ? 3 : 4;
          this.groundText.push({ m: flatText(tex, h * aspect, h, e.x, water ? groundY + 0.07 : groundY + 0.31, e.z), kind: 'district' });
        }
      }
    } else {
      const G = world.graph;
      const start = world.start;
      const order = G.nodes.map((_, i) => i).filter((i) => G.adj[i]!.length >= 3)
        .sort((a, b) => Math.hypot(G.nodes[a]!.x - start.x, G.nodes[a]!.z - start.z) - Math.hypot(G.nodes[b]!.x - start.x, G.nodes[b]!.z - start.z));
      const placed: { x: number; z: number }[] = [];
      const poleM = mats.make(0x6b7078, { roughness: 0.5, metalness: 0.4 }), edgeM = mats.make(0x24407f, { roughness: 0.5 });
      for (const ni of order) {
        if (placed.length >= 26) break;
        const n = G.nodes[ni]!;
        if (placed.some((p) => Math.hypot(p.x - n.x, p.z - n.z) < 14)) continue;
        const names: { name: string; tx: number; tz: number; w: number }[] = [];
        for (const ei of G.adj[ni]!) {
          const e = G.edges[ei]!;
          if (e.cls === 'alley' || !e.name || names.some((q) => q.name === e.name)) continue;
          const o = G.nodes[e.a === ni ? e.b : e.a]!;
          names.push({ name: e.name, tx: (o.x - n.x) / (e.len || 1), tz: (o.z - n.z) / (e.len || 1), w: ROAD_W[e.cls] });
        }
        if (names.length < 2) continue;
        placed.push(n);
        const off = Math.max(...names.map((q) => q.w)) / 2 + 1.0;
        const g = new Group();
        g.position.set(n.x + off * 0.8, groundY - 0.03, n.z + off * 0.8);
        this.group.add(g);
        const pole = new Mesh(new CylinderGeometry(0.05, 0.06, 3.4, 8).translate(0, 1.7, 0), poleM);
        pole.castShadow = true;
        g.add(pole);
        names.slice(0, 2).forEach((q, k) => {
          const { tex, aspect } = this.textCanvas(q.name, { size: 48, weight: 700, color: '#fff', bg: '#2C4F9E', radius: 6, padX: 26, padY: 10 });
          const face = mats.make(0xffffff, { map: tex, roughness: 0.5 });
          const hgt = 0.72;
          const board = new Mesh(new BoxGeometry(hgt * aspect, hgt, 0.04), [edgeM, edgeM, edgeM, edgeM, face, face]);
          board.position.set(0, 3.1 - k * 0.85, 0);
          board.rotation.y = Math.atan2(-q.tz, q.tx);
          board.castShadow = true;
          g.add(board);
        });
      }
      for (const e of entries) {
        if (e.kind !== 'district') continue;
        const water = !!e.water;
        const { tex, aspect } = this.textCanvas(title(e), { size: 96, weight: 700, color: water ? '#1F5E8C' : '#fff', bg: water ? 'rgba(221,239,251,.95)' : 'rgba(42,37,64,.9)', radius: 18, spacing: 20, padX: 40, padY: 16 });
        const sm = new SpriteMaterial({ map: tex, depthWrite: false, fog: false });
        this.mats.push(sm);
        const s = new Sprite(sm);
        s.scale.set(2 * aspect, 2, 1);
        s.position.set(e.x, water ? 3 : 11, e.z);
        s.renderOrder = 9;
        this.group.add(s);
      }
    }
    for (const e of entries) if (e.kind === 'poi') this.addPoiPin(e, title(e), mats, groundY);
    this.group.traverse((o) => { o.raycast = () => {}; });
  }

  /** Turns ground road text to face the camera bearing (degrees). */
  step(bearingDeg: number): void {
    const b = (bearingDeg * Math.PI) / 180, fx = Math.sin(b), fz = -Math.cos(b);
    for (const gt of this.groundText) {
      if (gt.kind === 'road' && gt.tx !== undefined && gt.tz !== undefined) {
        let th = Math.atan2(-gt.tz, gt.tx);
        // text "up" on screen = local −z rotated by th; flip when it points away from the view direction
        if (-Math.sin(th) * fx - Math.cos(th) * fz < 0) th += Math.PI;
        gt.m.rotation.y = th;
      } else gt.m.rotation.y = -b;
    }
  }

  clear(): void {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      c.traverse((o) => { const m = o as Mesh; if (m.isMesh) m.geometry.dispose(); });
    }
    for (const t of this.textures) t.dispose();
    for (const m of this.mats) m.dispose();
    this.textures = [];
    this.mats = [];
    this.groundText = [];
    this.built = '';
  }

  private addPoiPin(e: LabelEntry, text: string, mats: MaterialFactory, groundY: number): void {
    const col = cssHexToNumber(ICON_COLORS[e.icon]);
    const g = new Group();
    g.position.set(e.x, groundY - 0.03, e.z);
    const pole = new Mesh(new CylinderGeometry(0.03, 0.03, 1.2, 6).translate(0, 0.6, 0), mats.make(0xe8e8e8, { roughness: 0.5 }));
    const ball = new Mesh(new SphereGeometry(0.26, 16, 12).translate(0, 1.34, 0), mats.make(col, { roughness: 0.35, glow: 0.25, glowColor: col }));
    pole.castShadow = ball.castShadow = true;
    g.add(pole, ball);
    const { tex, aspect } = this.textCanvas(text, { size: 44, weight: 600, color: '#2A2F38', bg: 'rgba(255,255,255,.94)', radius: 32, padX: 22, padY: 8 });
    const sm = new SpriteMaterial({ map: tex, depthWrite: false, fog: false });
    this.mats.push(sm);
    const sp = new Sprite(sm);
    sp.scale.set(0.62 * aspect, 0.62, 1);
    sp.position.set(0, 1.95, 0);
    sp.renderOrder = 9;
    g.add(sp);
    this.group.add(g);
  }

  private textCanvas(text: string, o: TextOptions): { tex: Texture; aspect: number } {
    const size = o.size ?? 64, font = `${o.weight ?? 600} ${size}px ${FONT}`;
    const c = this.doc.createElement('canvas');
    const g = c.getContext('2d')!;
    g.font = font;
    const chars = [...text], ls = o.spacing ?? 0, padX = o.padX ?? 24, padY = o.padY ?? 12;
    const tw = chars.reduce((w, ch) => w + g.measureText(ch).width, 0) + ls * Math.max(0, chars.length - 1);
    c.width = Math.max(4, Math.ceil(tw + padX * 2));
    c.height = Math.ceil(size * 1.3 + padY * 2);
    if (o.bg) {
      g.fillStyle = o.bg;
      roundRectPath(g, 0, 0, c.width, c.height, o.radius ?? 12);
      g.fill();
    }
    g.font = font;
    g.textBaseline = 'middle';
    g.fillStyle = o.color ?? '#fff';
    let x = padX;
    for (const ch of chars) {
      g.fillText(ch, x, c.height / 2 + size * 0.04);
      x += g.measureText(ch).width + ls;
    }
    const tex = new CanvasTexture(c);
    tex.colorSpace = SRGBColorSpace;
    tex.anisotropy = 4;
    this.textures.push(tex);
    return { tex, aspect: c.width / c.height };
  }
}
