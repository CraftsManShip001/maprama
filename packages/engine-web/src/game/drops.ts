/**
 * Drop layers: instant client-side collection judgement (pure
 * {@link DropCollector}) and the prototype's item visuals (coin / gem, CD and
 * LP discs with alpha-tested holes, extruded music note, custom glTF model;
 * rarity beam, glow ring and orbiting note sprites; idle bob, collect pop,
 * "+value" text and chime).
 *
 * Collection rules:
 * - a collector is a character listed in the layer's `collectorIds`, or the
 *   `isPlayer` character when `collectorIds` is absent (`[]` = nobody);
 * - it collects a drop when its ground distance is ≤ `collectRadiusMeters`;
 * - every collection gets a fresh cryptographically random `collectId`;
 * - a drop is collected once per collector: the collected drop disappears,
 *   and while its id stays in every spec the host sends, the same collector
 *   cannot collect it again; removing the id and adding it back (as the React
 *   Native `DropLayer` does to restore a rejected drop) resets its history.
 *
 * @module
 */

import type { DropCollectEvent, DropSpec, DropType, LngLat, Rarity, WorldPoint } from '@maprama/protocol';
import {
  AdditiveBlending,
  CanvasTexture,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  Shape,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  type BufferGeometry,
  type Material,
  type Texture,
} from 'three';
import { ensureLabelStyles } from '../labels/dom-styles.js';
import { noRaycast, outlineScale } from '../render/parts.js';
import type { SceneApi } from '../scene-api.js';
import { clamp } from '../util/math.js';
import { instantiateModel, loadModel, normalizeModel } from './characters.js';
import { easeOutBack } from './vehicles.js';

// ---------------------------------------------------------------------------
// Collection (pure)
// ---------------------------------------------------------------------------

/** Rarity colors (prototype `RARITY`). */
export const RARITY_COLORS: Readonly<Record<Rarity, number>> = Object.freeze({ common: 0x6fb7ff, rare: 0xb07cff, legendary: 0xffc24a });

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** A random RFC 4122 v4 UUID from `crypto.randomUUID` / `crypto.getRandomValues`. */
export function randomCollectId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c && typeof c.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6]! & 0x0f) | 0x40;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const h = hex(b);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  throw new Error('crypto.getRandomValues is not available: cannot create a collectId');
}

/** A drop in a layer. */
export interface DropState {
  layerId: string;
  spec: DropSpec;
  x: number;
  z: number;
  collected: boolean;
}

/** A potential collector. */
export interface Collector {
  id: string;
  x: number;
  z: number;
  isPlayer: boolean;
}

interface LayerState {
  radius: number;
  collectors: string[] | null;
  drops: Map<string, DropState>;
}

/** Changes made by {@link DropCollector.setLayer}. */
export interface LayerDiff {
  added: DropState[];
  removed: DropState[];
  moved: DropState[];
}

/** Most recent collectIds remembered to rule out duplicates (older ones are forgotten; ids are random UUIDs). */
export const MAX_ISSUED_COLLECT_IDS = 10_000;

const sameLook = (a: DropSpec, b: DropSpec): boolean => a.type === b.type && (a.rarity ?? 'common') === (b.rarity ?? 'common') && a.model?.uri === b.model?.uri && a.value === b.value;

export class DropCollector {
  private layers = new Map<string, LayerState>();
  private history = new Set<string>();
  private issued = new Set<string>();

  constructor(private readonly newId: () => string = randomCollectId) {}

  /** Creates or replaces a layer (radius in world units). */
  setLayer(layerId: string, drops: readonly { spec: DropSpec; x: number; z: number }[], radiusUnits: number, collectorIds?: readonly string[]): LayerDiff {
    const prev = this.layers.get(layerId);
    const next: LayerState = { radius: Math.max(0, radiusUnits), collectors: collectorIds ? [...collectorIds] : null, drops: new Map() };
    const diff: LayerDiff = { added: [], removed: [], moved: [] };
    for (const d of drops) {
      const old = prev?.drops.get(d.spec.id);
      if (old && !old.collected && sameLook(old.spec, d.spec)) {
        const moved = old.x !== d.x || old.z !== d.z;
        old.spec = d.spec;
        old.x = d.x;
        old.z = d.z;
        next.drops.set(d.spec.id, old);
        if (moved) diff.moved.push(old);
      } else {
        if (old && !old.collected) diff.removed.push(old);
        // A drop id absent from the previous spec is (re-)added by the host, e.g. restored after a rejected
        // server verification: forget earlier collections of it so it can be collected again.
        if (!old) this.forget(`${layerId}\0${d.spec.id}\0`);
        const s: DropState = { layerId, spec: d.spec, x: d.x, z: d.z, collected: false };
        next.drops.set(d.spec.id, s);
        diff.added.push(s);
      }
    }
    if (prev) for (const [id, old] of prev.drops) if (!next.drops.has(id) && !old.collected) diff.removed.push(old);
    this.layers.set(layerId, next);
    return diff;
  }

  removeLayer(layerId: string): DropState[] {
    const l = this.layers.get(layerId);
    if (!l) return [];
    this.layers.delete(layerId);
    this.forget(`${layerId}\0`);
    return [...l.drops.values()].filter((d) => !d.collected);
  }

  layerIds(): string[] {
    return [...this.layers.keys()];
  }

  drops(layerId: string): DropState[] {
    return [...(this.layers.get(layerId)?.drops.values() ?? [])];
  }

  /** Judges collections; each returned event already marked its drop collected. */
  check(collectors: readonly Collector[], toLngLat: (p: WorldPoint) => LngLat): { event: DropCollectEvent; drop: DropState }[] {
    const out: { event: DropCollectEvent; drop: DropState }[] = [];
    for (const [layerId, layer] of this.layers) {
      const allowed = layer.collectors ? collectors.filter((c) => layer.collectors!.includes(c.id)) : collectors.filter((c) => c.isPlayer);
      if (!allowed.length) continue;
      const r2 = layer.radius * layer.radius;
      for (const d of layer.drops.values()) {
        if (d.collected) continue;
        for (const c of allowed) {
          const key = `${layerId}\0${d.spec.id}\0${c.id}`;
          if (this.history.has(key)) continue;
          const dx = c.x - d.x, dz = c.z - d.z;
          if (dx * dx + dz * dz > r2) continue;
          d.collected = true;
          this.history.add(key);
          out.push({
            drop: d,
            event: { type: 'drop:collect', layerId, dropId: d.spec.id, characterId: c.id, coordinate: toLngLat({ x: c.x, z: c.z }), collectId: this.uniqueId() },
          });
          break;
        }
      }
    }
    return out;
  }

  private forget(prefix: string): void {
    for (const key of this.history) if (key.startsWith(prefix)) this.history.delete(key);
  }

  private uniqueId(): string {
    for (let i = 0; i < 8; i++) {
      const id = this.newId();
      if (id && !this.issued.has(id)) {
        this.issued.add(id);
        // Sets iterate in insertion order: drop the oldest id once the cap is exceeded.
        if (this.issued.size > MAX_ISSUED_COLLECT_IDS) this.issued.delete(this.issued.values().next().value!);
        return id;
      }
    }
    throw new Error('collectId generator keeps returning duplicates');
  }
}

// ---------------------------------------------------------------------------
// Visuals
// ---------------------------------------------------------------------------

const shared = <T extends BufferGeometry>(g: T): T => {
  g.userData.shared = true;
  return g;
};

let GEO: { coin: BufferGeometry; gem: BufferGeometry; disc: BufferGeometry; note: BufferGeometry; beam: BufferGeometry; ring: BufferGeometry } | null = null;
function geos(): NonNullable<typeof GEO> {
  if (!GEO) {
    const head = new Shape();
    head.absellipse(0, 0, 0.19, 0.135, 0, Math.PI * 2, false, 0.35);
    const stem = new Shape();
    stem.moveTo(0.13, 0.04); stem.lineTo(0.19, 0.04); stem.lineTo(0.19, 0.6);
    stem.quadraticCurveTo(0.33, 0.55, 0.36, 0.36); stem.quadraticCurveTo(0.42, 0.62, 0.19, 0.8);
    stem.lineTo(0.13, 0.8); stem.lineTo(0.13, 0.04);
    const note = new ExtrudeGeometry([head, stem], { depth: 0.07, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.015, bevelSegments: 2 });
    note.center();
    note.scale(1.45, 1.45, 1.45);
    GEO = {
      coin: shared(new CylinderGeometry(0.46, 0.46, 0.14, 24).rotateX(Math.PI / 2)),
      gem: shared(new OctahedronGeometry(0.46, 0)),
      disc: shared(new CylinderGeometry(0.58, 0.58, 0.03, 48)),
      note: shared(note),
      beam: shared(new CylinderGeometry(0.22, 0.42, 5, 20, 1, true).translate(0, 2.5, 0)),
      ring: shared(new PlaneGeometry(2.2, 2.2).rotateX(-Math.PI / 2)),
    };
  }
  return GEO;
}

type ItemState = 'appear' | 'idle' | 'pop';

interface Item {
  key: string;
  drop: DropState;
  g: Group;
  spin: Group;
  fx: Group | null;
  beam: Mesh | null;
  ring: Mesh | null;
  sprites: Sprite[];
  music: boolean;
  state: ItemState;
  t: number;
  phase: number;
  groundY: number;
}

const keyOf = (d: DropState): string => `${d.layerId}\0${d.spec.id}`;
const cssHex = (n: number): string => '#' + n.toString(16).padStart(6, '0');

export interface DropVisualsOptions {
  onModelError(dropKey: string, uri: string, err: unknown): void;
}

/** Renders drops and their collect effects. */
export class DropVisuals {
  readonly group = new Group();
  private items = new Map<string, Item>();
  private themed = new Map<string, Material>();
  private fxMats = new Map<string, Material>();
  private textures = new Map<string, Texture>();
  private audio: AudioContext | null = null;
  private readonly unlockAudio = (): void => {
    try {
      const W = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
      const Ctor = W.AudioContext ?? W.webkitAudioContext;
      if (!Ctor) return;
      if (!this.audio) this.audio = new Ctor();
      else if (this.audio.state === 'suspended') void this.audio.resume();
    } catch {
      this.audio = null;
    }
  };
  /** Play a short chime on music drop collection when audio is unlocked. */
  sound = true;

  /** Number of drop items on screen (appearing, idling or collecting). */
  get count(): number {
    return this.items.size;
  }

  /**
   * True while the drops need frames. Every item animates: idle drops keep
   * bobbing and spinning (slower, but not stopped, with reduced motion) and
   * collected ones fly up until they are removed.
   */
  get animating(): boolean {
    return this.items.size > 0;
  }

  constructor(private readonly scene: SceneApi, private readonly options: DropVisualsOptions) {
    this.group.name = 'drops';
    scene.container.addEventListener('pointerdown', this.unlockAudio, { passive: true });
  }

  add(d: DropState, groundY: number): void {
    this.removeImmediate(keyOf(d));
    const type = d.spec.type, rarity = d.spec.rarity ?? 'common';
    const g = new Group(), spin = new Group();
    g.add(spin);
    const music = type !== 'coin';
    const M = this.scene.materials;
    if (type === 'coin') this.addCoin(spin, d);
    else if (type === 'note') this.part(spin, geos().note, this.themedMat(`note:${rarity}`, () => M.make(RARITY_COLORS[rarity], { roughness: 0.3, metalness: 0.2, glow: 0.45, glowColor: RARITY_COLORS[rarity] })), 0.025);
    else if (type === 'model') this.addModel(spin, d);
    else this.addDisc(spin, type, rarity);
    const item: Item = { key: keyOf(d), drop: d, g, spin, fx: null, beam: null, ring: null, sprites: [], music, state: 'appear', t: 0, phase: (hash(d.spec.id) % 628) / 100, groundY };
    if (music || rarity !== 'common') this.addFx(item, rarity, type === 'coin' ? 0 : 3);
    g.position.set(d.x, groundY + 0.9, d.z);
    g.scale.setScalar(this.scene.reduceMotion ? 1 : 0.001);
    if (this.scene.reduceMotion) item.state = 'idle';
    g.traverse((o) => { o.raycast = noRaycast; });
    this.group.add(g);
    this.items.set(item.key, item);
  }

  move(d: DropState): void {
    const it = this.items.get(keyOf(d));
    if (!it) return;
    it.g.position.x = d.x;
    it.g.position.z = d.z;
    if (it.fx) { it.fx.position.x = d.x; it.fx.position.z = d.z; }
  }

  /** Removes without effect (layer replaced / removed). */
  removeImmediate(key: string): void {
    const it = this.items.get(key);
    if (!it) return;
    this.items.delete(key);
    this.group.remove(it.g);
    if (it.fx) this.group.remove(it.fx);
    for (const s of it.sprites) this.group.remove(s);
    it.g.traverse((o) => { const m = o as Mesh; if (m.isMesh && !m.geometry.userData.shared && !o.userData.model) m.geometry.dispose(); });
  }

  remove(d: DropState): void {
    this.removeImmediate(keyOf(d));
  }

  /** Plays the collect pop (item removed when done). */
  collect(d: DropState): void {
    const it = this.items.get(keyOf(d));
    if (!it || it.state === 'pop') return;
    it.state = 'pop';
    it.t = 0;
    const layer = this.scene.overlayLayer;
    const doc = layer.ownerDocument;
    ensureLabelStyles(doc);
    const s = this.scene.camera.worldToScreen(it.g.position.x, it.g.position.y + 1, it.g.position.z);
    if (s.visible) {
      const el = doc.createElement('div');
      el.className = 'mpr-plus';
      if (it.music) {
        el.textContent = '♪ +1';
        el.style.color = cssHex(RARITY_COLORS[d.spec.rarity ?? 'common']);
      } else el.textContent = `+${d.spec.value ?? 10}`;
      el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, -100%)`;
      layer.appendChild(el);
      setTimeout(() => el.remove(), 950);
    }
    if (it.music) this.chime(d.spec.rarity ?? 'common');
  }

  step(dt: number, t: number): void {
    const rm = this.scene.reduceMotion;
    for (const it of [...this.items.values()]) {
      const g = it.g;
      if (it.state === 'appear' || it.state === 'idle') {
        it.t += dt;
        if (it.state === 'appear') {
          const k = clamp(it.t / 0.35, 0, 1);
          g.scale.setScalar(Math.max(0.001, easeOutBack(k)));
          if (k >= 1) { it.state = 'idle'; g.scale.setScalar(1); }
        }
        // The hover (and its bob) is an anchor height: the flat view brings it down to the ground,
        // where the item marks its own coordinate instead of floating beside it.
        const hover = this.scene.anchorHeightScale();
        g.position.y = it.groundY + hover * ((it.music ? 0.95 : 0.9) + (rm ? 0 : Math.sin(t * (it.music ? 2.4 : 3) + it.phase) * (it.music ? 0.1 : 0.12)));
        it.spin.rotation.y += dt * (rm ? 0.5 : it.music ? 1.6 : 2.2);
        if (it.fx && it.beam && it.ring) {
          const appear = Math.min(1, it.t / 0.5);
          it.beam.scale.set(1, Math.max(0.001, appear * (it.drop.spec.rarity === 'legendary' ? 1.5 : 1)), 1);
          it.ring.scale.setScalar(0.8 + (rm ? 0 : Math.sin(t * 3 + it.phase) * 0.12));
          it.sprites.forEach((s, k) => {
            const a = t * 1.1 + it.phase + k * 2.094;
            s.position.set(g.position.x + Math.cos(a) * 0.62, g.position.y + 0.35 + Math.sin(t * 2 + k) * 0.25, g.position.z + Math.sin(a) * 0.62);
          });
        }
      } else {
        it.t += dt;
        const k = it.t / 0.45;
        g.position.y += dt * 5;
        it.spin.rotation.y += dt * 14;
        g.scale.setScalar(k < 0.4 ? 1 + k * 1.5 : Math.max(0.001, (1.6 * (1 - k)) / 0.6));
        if (it.beam) it.beam.scale.y = Math.max(0.001, 1 - k);
        for (const s of it.sprites) s.position.y += dt * 3;
        if (k >= 1 || rm) this.removeImmediate(it.key);
      }
    }
  }

  onThemeChange(): void {
    this.themed.clear();
    const outline = this.scene.params().outline;
    this.group.traverse((o) => { if (o.userData.outline) o.visible = outline; });
  }

  clear(): void {
    for (const k of [...this.items.keys()]) this.removeImmediate(k);
  }

  dispose(): void {
    this.clear();
    this.scene.container.removeEventListener('pointerdown', this.unlockAudio);
    for (const m of this.fxMats.values()) m.dispose();
    for (const t of this.textures.values()) t.dispose();
    this.fxMats.clear();
    this.textures.clear();
    void this.audio?.close().catch(() => {});
  }

  // ---- parts ----

  private part(parent: Group, geo: BufferGeometry, mat: Material | Material[], outline: number): Mesh {
    const m = new Mesh(geo, mat);
    m.castShadow = true;
    parent.add(m);
    if (outline) {
      const o = new Mesh(geo, this.scene.materials.ink);
      outlineScale(o, geo, outline);
      o.userData.outline = true;
      o.visible = this.scene.params().outline;
      parent.add(o);
    }
    return m;
  }

  private themedMat(key: string, make: () => Material): Material {
    let m = this.themed.get(key);
    if (!m) { m = make(); this.themed.set(key, m); }
    return m;
  }

  private addCoin(spin: Group, d: DropState): void {
    const M = this.scene.materials;
    const gem = (d.spec.value ?? 10) >= 50;
    this.part(spin, gem ? geos().gem : geos().coin, gem ? this.themedMat('gem', () => M.make(0x8fe3f0, { roughness: 0.2 })) : this.themedMat('gold', () => M.make(0xffc93c, { roughness: 0.35, metalness: 0.35 })), 0.05);
  }

  private addDisc(spin: Group, type: 'cd' | 'vinyl', rarity: Rarity): void {
    const M = this.scene.materials;
    const tex = this.discTexture(type, rarity);
    const face = this.themedMat(`disc:${type}:${rarity}`, () => M.make(0xffffff, { map: tex, alphaTest: 0.5, roughness: type === 'cd' ? 0.18 : 0.35, metalness: type === 'cd' ? 0.35 : 0.1, glow: type === 'cd' ? 0.35 : 0.12, glowMap: tex }));
    const rim = type === 'cd' ? this.themedMat('chrome', () => M.make(0xc9cdd2, { roughness: 0.3, metalness: 0.6 })) : this.themedMat('tire', () => M.make(0x1f2023, { roughness: 0.85 }));
    const disc = new Mesh(geos().disc, [rim, face, face]);
    disc.rotation.x = Math.PI / 2;
    disc.castShadow = true;
    spin.add(disc);
    const ol = new Mesh(geos().disc, this.scene.materials.ink);
    outlineScale(ol, geos().disc, 0.025);
    ol.rotation.x = Math.PI / 2;
    ol.userData.outline = true;
    ol.visible = this.scene.params().outline;
    spin.add(ol);
  }

  private addModel(spin: Group, d: DropState): void {
    const uri = d.spec.model?.uri;
    if (!uri) { this.addCoin(spin, d); return; }
    const key = keyOf(d);
    loadModel(uri).then((gltf) => {
      const it = this.items.get(key);
      if (!it || it.spin !== spin) return;
      const wrap = normalizeModel(instantiateModel(gltf), 1.1, true);
      wrap.position.y = -0.45;
      spin.add(wrap);
      this.scene.requestRender(); // a late-arriving model changes the picture outside any frame hook
    }, (err: unknown) => {
      const it = this.items.get(key);
      if (it && it.spin === spin) this.addCoin(spin, d);
      this.scene.requestRender();
      this.options.onModelError(key, uri, err);
    });
  }

  private addFx(it: Item, rarity: Rarity, sprites: number): void {
    const color = RARITY_COLORS[rarity];
    const tex = this.scene.textures();
    const fx = new Group();
    fx.position.set(it.drop.x, it.groundY + 0.07, it.drop.z);
    const beam = new Mesh(geos().beam, this.fxMat(`beam:${rarity}`, () => new MeshBasicMaterial({ color, map: tex.beam, transparent: true, opacity: 0.8, blending: AdditiveBlending, depthWrite: false, side: DoubleSide })));
    beam.renderOrder = 3;
    beam.scale.y = 0.001;
    const ring = new Mesh(geos().ring, this.fxMat(`ring:${rarity}`, () => new MeshBasicMaterial({ color, map: tex.glow, transparent: true, opacity: 0.7, blending: AdditiveBlending, depthWrite: false })));
    ring.renderOrder = 3;
    fx.add(beam, ring);
    fx.traverse((o) => { o.raycast = noRaycast; });
    this.group.add(fx);
    it.fx = fx;
    it.beam = beam;
    it.ring = ring;
    const noteTex = this.noteTexture();
    for (let k = 0; k < sprites; k++) {
      const s = new Sprite(this.fxMat(`note:${rarity}`, () => new SpriteMaterial({ map: noteTex, color, transparent: true, depthWrite: false, fog: false })) as SpriteMaterial);
      s.scale.setScalar(0.34);
      s.position.set(it.drop.x, it.groundY + 1.2, it.drop.z);
      s.raycast = noRaycast;
      this.group.add(s);
      it.sprites.push(s);
    }
  }

  private fxMat(key: string, make: () => Material): Material {
    let m = this.fxMats.get(key);
    if (!m) { m = make(); this.fxMats.set(key, m); }
    return m;
  }

  private canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
    const c = this.scene.container.ownerDocument.createElement('canvas');
    c.width = w;
    c.height = h;
    return [c, c.getContext('2d')!];
  }

  private noteTexture(): Texture {
    let t = this.textures.get('note');
    if (!t) {
      const [c, g] = this.canvas(64, 64);
      g.shadowColor = 'rgba(255,255,255,.9)';
      g.shadowBlur = 8;
      g.fillStyle = '#fff';
      g.font = 'bold 50px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('♪', 32, 34);
      t = new CanvasTexture(c);
      this.textures.set('note', t);
    }
    return t;
  }

  /** CD / LP label texture with transparent spindle hole (prototype `discTexture`). */
  private discTexture(type: 'cd' | 'vinyl', rarity: Rarity): Texture {
    const key = `disc:${type}:${rarity}`;
    let t = this.textures.get(key);
    if (t) return t;
    const S = 256, R = S / 2, color = cssHex(RARITY_COLORS[rarity]);
    const [c, g] = this.canvas(S, S);
    if (type === 'cd') {
      const base = g.createRadialGradient(R, R, 20, R, R, R);
      base.addColorStop(0, '#F4F6F8');
      base.addColorStop(1, '#AEB6BE');
      g.fillStyle = base; g.beginPath(); g.arc(R, R, R - 1, 0, Math.PI * 2); g.fill();
      for (let a = 0; a < 360; a += 3) { g.fillStyle = `hsla(${(a * 2) % 360}, 90%, 65%, .24)`; g.beginPath(); g.moveTo(R, R); g.arc(R, R, R - 1, (a * Math.PI) / 180, ((a + 3.5) * Math.PI) / 180); g.closePath(); g.fill(); }
      g.globalAlpha = 0.9; g.fillStyle = color; g.beginPath(); g.arc(R, R, 80, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
      g.fillStyle = 'rgba(255,255,255,.88)'; g.fillRect(R - 40, R + 36, 80, 6); g.fillRect(R - 26, R + 48, 52, 4);
      g.fillStyle = 'rgba(232,238,242,.95)'; g.beginPath(); g.arc(R, R, 30, 0, Math.PI * 2); g.fill();
      g.globalCompositeOperation = 'destination-out'; g.beginPath(); g.arc(R, R, 14, 0, Math.PI * 2); g.fill(); g.globalCompositeOperation = 'source-over';
    } else {
      g.fillStyle = '#141416'; g.beginPath(); g.arc(R, R, R - 1, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1;
      for (let rr = 46; rr < R - 4; rr += 3) { g.beginPath(); g.arc(R, R, rr, 0, Math.PI * 2); g.stroke(); }
      g.fillStyle = 'rgba(255,255,255,.08)';
      g.beginPath(); g.moveTo(R, R); g.arc(R, R, R - 2, -0.9, -0.4); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(R, R); g.arc(R, R, R - 2, 2.2, 2.7); g.closePath(); g.fill();
      g.fillStyle = color; g.beginPath(); g.arc(R, R, 42, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,.82)'; g.fillRect(R - 20, R + 12, 40, 4);
      g.globalCompositeOperation = 'destination-out'; g.beginPath(); g.arc(R, R, 5, 0, Math.PI * 2); g.fill(); g.globalCompositeOperation = 'source-over';
    }
    t = new CanvasTexture(c);
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 4;
    this.textures.set(key, t);
    return t;
  }

  private chime(rarity: Rarity): void {
    const a = this.audio;
    if (!a || !this.sound || a.state !== 'running') return;
    const notes = rarity === 'legendary' ? [659, 784, 988, 1319] : rarity === 'rare' ? [587, 740, 880] : [523, 659, 784];
    const t0 = a.currentTime;
    notes.forEach((f, i) => {
      const o = a.createOscillator(), gn = a.createGain(), st = t0 + i * 0.07;
      o.type = 'triangle';
      o.frequency.value = f;
      gn.gain.setValueAtTime(0.0001, st);
      gn.gain.linearRampToValueAtTime(0.1, st + 0.012);
      gn.gain.exponentialRampToValueAtTime(0.0008, st + 0.5);
      o.connect(gn);
      gn.connect(a.destination);
      o.start(st);
      o.stop(st + 0.55);
    });
  }
}

const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** Drop types that show music effects. */
export const MUSIC_DROP_TYPES: readonly DropType[] = ['cd', 'vinyl', 'note', 'model'];
