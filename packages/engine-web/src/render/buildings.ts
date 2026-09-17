/**
 * Building renderer for every world source. Each building is decomposed into
 * masses (rings + height); rectangular lots use the prototype massing
 * (`box | podium | setback | L | twin`), arbitrary polygons use stacked
 * scaled tiers. The same code then draws facade walls (UVs along edge length
 * so textures tile per floor), storefront bands, flat roofs with parapets,
 * gravel / membranes / decks / solar / HVAC, soft rounded masses with domes,
 * gable and dome roofs (rectangles), facade details (slab edges, fins,
 * balconies with glass rails, eyebrows, cornice ring), contact-shadow decals,
 * decorations, the landmark tower, the captured flag + glow, per-building
 * style overrides and glTF model replacement.
 *
 * @module
 */

import {
  Box3,
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  Shape,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
  type Material,
  type Object3D,
  type Raycaster,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { BuildingKind, BuildingStyle, Massing, Vec2 } from '@maprama/protocol';
import { cssHexToNumber, mixHex, mulberry32, offsetHslHex } from '../util/math.js';
import type { BuildingModel, MassShape, RoofKind } from '../world/model.js';
import { bbox, centroid, normalizeRing, offsetRing, pointInPolygon, scaleRing } from '../world/polygon.js';
import type { FacadeKey } from '../theme/textures.js';
import { ACCENT, type MaterialFactory } from '../theme/materials.js';
import { mergeBoxes, mergeFlat, type BoxSpec } from './geometry.js';
import { insideRadius, prismGeometry, ringBandGeometry, softMassGeometry, wallsGeometry } from './footprint.js';
import { addPart, clearGroup, noRaycast, tree, type RenderContext } from './parts.js';

const MODERN_MAP: Record<BuildingKind, string> = { glass: 'glass', office: 'band', apartment: 'resi', brick: 'terracotta' };
const URBAN_MAP: Record<BuildingKind, string> = { glass: 'glass', office: 'panel', apartment: 'grid', brick: 'concrete' };
/** Urban color schemes (wall tint + trim) used with facade details. */
export const URBAN_SCHEMES = [
  { name: 'stone-bronze', tint: '#F3EEE5', trim: 0x8a6d4a },
  { name: 'white-graphite', tint: '#F6F7F8', trim: 0x3a3f45 },
  { name: 'warmgray-champagne', tint: '#E6E2DC', trim: 0xc2ab84 },
  { name: 'coolgray-silver', tint: '#DFE5EA', trim: 0xaeb7bf },
  { name: 'sage-white', tint: '#E0E8E1', trim: 0xf1f2ef },
];
const GLOW_COLOR = 0xffd36e;

/** Normalized per-building override (from protocol `BuildingStyle`). */
export interface BuildingOverride {
  color?: number;
  roof?: RoofKind;
  facade?: boolean;
  decos?: { sign: boolean; antenna: boolean; garden: boolean };
  massing?: Massing;
  state?: string;
  modelUri?: string;
}

export function overrideFromStyle(style: BuildingStyle): BuildingOverride {
  const o: BuildingOverride = {};
  if (style.color) o.color = cssHexToNumber(style.color);
  if (style.roof) o.roof = style.roof;
  if (style.facade !== undefined) o.facade = style.facade;
  if (style.decorations) {
    o.decos = { sign: style.decorations.includes('sign'), antenna: style.decorations.includes('antenna'), garden: style.decorations.includes('trees') };
  }
  if (style.massing) o.massing = style.massing;
  if (style.state !== undefined) o.state = style.state;
  if (style.replaceModel) o.modelUri = style.replaceModel.uri;
  return o;
}

interface Mass {
  /** Local ring (normalized). */
  ring: Vec2[];
  x: number;
  z: number;
  w: number;
  d: number;
  y: number;
  h: number;
  bridge?: boolean;
  rect: boolean;
}

interface Entry {
  b: BuildingModel;
  group: Group;
  glow: MeshStandardMaterial[];
  spin: Object3D | null;
  top: number;
  topX: number;
  topZ: number;
  bounce: number;
  style: BuildingOverride;
  model: Object3D | null;
  modelUri: string | null;
}

export interface BuildingInfo {
  id: string;
  /** World position of the roof top center. */
  top: { x: number; y: number; z: number };
  model: BuildingModel;
}

/** Local rectangle ring (axis aligned) around (x, z). */
const rectRing = (x: number, z: number, w: number, d: number): Vec2[] =>
  normalizeRing([[x - w / 2, z - d / 2], [x + w / 2, z - d / 2], [x + w / 2, z + d / 2], [x - w / 2, z + d / 2]]);

/** Prototype `massesFor` for rectangular lots (local frame). */
export function rectMasses(b: BuildingModel, shape: MassShape, H: number): Mass[] {
  const bw = b.rect?.w ?? 1, bd = b.rect?.d ?? 1;
  const r = mulberry32(b.idx * 31 + 5), sx = r() < 0.5 ? -1 : 1, sz = r() < 0.5 ? -1 : 1;
  const swap = shape === 'twin' && bd > bw;
  const w = swap ? bd : bw, d = swap ? bw : bd, h = H;
  type M = { w: number; d: number; h: number; x: number; z: number; y: number; bridge?: boolean };
  let ms: M[];
  switch (shape) {
    case 'podium': {
      const ph = Math.min(0.8, h * 0.3), tw = w * 0.62, td = d * 0.62;
      ms = [{ w, d, h: ph, x: 0, z: 0, y: 0 }, { w: tw, d: td, h: h - ph, x: sx * (w - tw) * 0.3, z: sz * (d - td) * 0.3, y: ph }];
      break;
    }
    case 'setback': {
      const h1 = h * 0.46, h2 = h * 0.3;
      ms = [{ w, d, h: h1, x: 0, z: 0, y: 0 }, { w: w * 0.8, d: d * 0.8, h: h2, x: sx * w * 0.05, z: sz * d * 0.05, y: h1 }, { w: w * 0.58, d: d * 0.58, h: h - h1 - h2, x: sx * w * 0.1, z: sz * d * 0.1, y: h1 + h2 }];
      break;
    }
    case 'L':
      ms = [{ w, d: d * 0.46, h, x: 0, z: -sz * d * 0.27, y: 0 }, { w: w * 0.46, d: d * 0.54, h: h * 0.68, x: sx * w * 0.27, z: sz * d * 0.23, y: 0 }];
      break;
    case 'twin': {
      const tw = w * 0.4;
      ms = [{ w: tw, d: d * 0.78, h, x: -w * 0.29, z: 0, y: 0 }, { w: tw, d: d * 0.78, h: h * 0.8, x: w * 0.29, z: 0, y: 0 }, { w: w * 0.2, d: d * 0.3, h: 0.34, x: 0, z: 0, y: h * 0.52, bridge: true }];
      break;
    }
    default:
      ms = [{ w, d, h, x: 0, z: 0, y: 0 }];
  }
  if (swap) ms = ms.map((m) => ({ ...m, w: m.d, d: m.w, x: m.z, z: m.x }));
  return ms.map((m) => ({ ...m, ring: rectRing(m.x, m.z, m.w, m.d), rect: true }));
}

/** Stacked tiers for arbitrary polygons (local ring centered on its centroid). */
export function polygonMasses(ring: Vec2[], shape: MassShape, H: number): Mass[] {
  const bb = bbox(ring), c = centroid(ring);
  const base = { x: c.x, z: c.z, w: bb.maxX - bb.minX, d: bb.maxZ - bb.minZ, rect: false };
  const tier = (s: number, y: number, h: number): Mass => ({ ...base, ring: s === 1 ? ring : scaleRing(ring, c.x, c.z, s), w: base.w * s, d: base.d * s, y, h });
  switch (shape) {
    case 'podium': {
      const ph = Math.min(0.8, H * 0.3);
      return [tier(1, 0, ph), tier(0.62, ph, H - ph)];
    }
    case 'setback':
    case 'L':
    case 'twin': {
      const h1 = H * 0.46, h2 = H * 0.3;
      return [tier(1, 0, h1), tier(0.8, h1, h2), tier(0.58, h1 + h2, H - h1 - h2)];
    }
    default:
      return [tier(1, 0, H)];
  }
}

interface EdgeInfo { ax: number; az: number; L: number; ux: number; uz: number; nx: number; nz: number; mx: number; mz: number; yaw: number }

function edgesOf(ring: readonly Vec2[]): EdgeInfo[] {
  const out: EdgeInfo[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
    if (L < 1e-4) continue;
    const ux = dx / L, uz = dz / L;
    out.push({ ax: a[0], az: a[1], L, ux, uz, nx: uz, nz: -ux, mx: a[0] + dx / 2, mz: a[1] + dz / 2, yaw: Math.atan2(-uz, ux) });
  }
  return out;
}

/** Long facade edges: the two ±z edges of a rectangle (prototype front/back), or long polygon edges. */
function longEdges(m: Mass): EdgeInfo[] {
  const es = edgesOf(m.ring);
  if (m.rect) return es.filter((e) => Math.abs(e.uz) < 1e-6);
  const maxL = Math.max(...es.map((e) => e.L));
  return es.filter((e) => e.L >= Math.max(1.5, maxL * 0.5));
}

const fits = (ring: readonly Vec2[], cx: number, cz: number, w: number, d: number): boolean =>
  [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].every(([u, v]) => pointInPolygon(cx + u!, cz + v!, ring));

/**
 * True when two `BuildingModel`s with the same id would produce **identical
 * meshes** — i.e. they differ at most by where their anchor sits.
 *
 * `buildOne` reads the footprint only through `localRing`, which subtracts the
 * anchor and un-rotates by `yaw`, so a pure translation (what a re-base is)
 * leaves every vertex it generates unchanged. Everything else `buildOne`
 * branches on is compared here: the seed (`idx`), the height, the rectangle,
 * the palette index, the kind, the roof, the decorations, the auto massing and
 * the landmark flag.
 *
 * Everything continuous is compared **to a tolerance**, and the ring is
 * compared relative to the anchor. The reason is arithmetic rather than
 * sloppiness: the same tile assembled around two different anchors runs the
 * same values through different float subtractions, so the ring offsets — and
 * with them the centroid, the fitted rectangle and the yaw derived from them —
 * agree to the float64 round-off of a world coordinate and not exactly. The
 * tolerances are far below anything that could reach a pixel: {@link SHAPE_EPS}
 * world units is 8 µm of ground, and {@link YAW_EPS} radians is 0.02 arcsec.
 */
export function sameShape(a: BuildingModel, b: BuildingModel): boolean {
  if (a.idx !== b.idx || a.ci !== b.ci || a.levels !== b.levels) return false;
  if (a.kind !== b.kind || a.roof !== b.roof || a.autoShape !== b.autoShape || a.landmark !== b.landmark) return false;
  if (a.decos.sign !== b.decos.sign || a.decos.antenna !== b.decos.antenna || a.decos.garden !== b.decos.garden) return false;
  if (!near(a.h, b.h, SHAPE_EPS) || !near(a.yaw, b.yaw, YAW_EPS)) return false;
  if ((a.rect === null) !== (b.rect === null)) return false;
  if (a.rect && b.rect && (!near(a.rect.w, b.rect.w, SHAPE_EPS) || !near(a.rect.d, b.rect.d, SHAPE_EPS))) return false;
  if (a.footprint.length !== b.footprint.length) return false;
  for (let i = 0; i < a.footprint.length; i++) {
    const p = a.footprint[i]!, q = b.footprint[i]!;
    if (!near(p[0] - a.x, q[0] - b.x, SHAPE_EPS) || !near(p[1] - a.z, q[1] - b.z, SHAPE_EPS)) return false;
  }
  return true;
}

/** Largest difference in world units two shapes may have and still count as one. */
const SHAPE_EPS = 1e-6;
/** Largest difference in radians two yaws may have and still count as one. */
const YAW_EPS = 1e-7;

const near = (x: number, y: number, eps: number): boolean => Math.abs(x - y) <= eps;

export type ModelLoader = (uri: string) => Promise<Object3D>;

export class BuildingRenderer {
  readonly group = new Group();
  private entries = new Map<string, Entry>();
  private readonly styleMap = new Map<string, BuildingOverride>();
  private ctx: RenderContext | null = null;
  private modelCache = new Map<string, Promise<Object3D>>();
  private _animating = false;
  /** Called when a replacement model fails to load. */
  onModelError: ((id: string, uri: string, error: unknown) => void) | null = null;
  /** Called after a replacement model arrived and the building was rebuilt (on-demand rendering needs a frame). */
  onModelLoaded: ((id: string) => void) | null = null;
  loadModel: ModelLoader = (uri) => new GLTFLoader().loadAsync(uri).then((g) => g.scene);

  constructor() {
    this.group.name = 'buildings';
  }

  /**
   * (Re)creates all buildings of the context's world. Styles survive rebuilds
   * for the same world.
   *
   * ### `incremental`
   *
   * A streamed tile world hands the renderer a **new `WorldModel` on every tile
   * change**, and rebuilding 4,345 buildings from scratch is what turns a pan
   * across a tile boundary into a multi-second stall (measured: 452 ms of CPU
   * to rebuild, plus the GPU upload of every buffer it just replaced, plus a
   * full shadow-map redraw over brand-new meshes).
   *
   * But a tile change adds and drops *tiles*, not buildings: the several
   * thousand buildings that were already there come back byte-identical, and a
   * re-base translates every one of them by the same delta. Both cases are
   * handled here by keeping the built `Group` and moving it:
   *
   * - a building whose id is still present and whose **shape** is unchanged
   *   ({@link sameShape}, which compares everything `buildOne` reads *except*
   *   the anchor) keeps its meshes, and only `group.position` is re-set — which
   *   is exactly what a re-base needs, since the group's contents are in the
   *   building's own local frame;
   * - a building that arrived is built;
   * - a building that left is disposed.
   *
   * Reuse is refused outright when the *theme* moved (a different
   * `RenderParams`, `MaterialFactory` or `TextureSet` object, or a different
   * `buildingBaseY`), because every mesh was built in a material generation
   * that `applyTheme` is about to drop. So `setTheme` still rebuilds
   * everything, and only the tile path asks for reuse.
   */
  build(ctx: RenderContext, incremental = false): void {
    const prev = this.ctx;
    const sameWorld = prev?.world === ctx.world;
    // The theme owns the materials every mesh holds: reuse across a theme
    // change would draw with a disposed generation.
    const reuse = incremental && prev !== null
      && prev.params === ctx.params && prev.mats === ctx.mats && prev.tex === ctx.tex
      && prev.world.buildingBaseY === ctx.world.buildingBaseY;
    this.ctx = ctx;
    // Per-building style overrides are keyed by id and survive a tile update
    // for the same reason a marker does: the world grew, it did not reload.
    const oldStyles = sameWorld || reuse ? new Map([...this.entries].map(([id, e]) => [id, e.style])) : new Map<string, BuildingOverride>();
    if (!sameWorld && !reuse) this.styleMap.clear();
    const old = this.entries;
    if (!reuse) {
      clearGroup(this.group);
      old.clear();
    }
    const next = new Map<string, Entry>();
    for (const b of ctx.world.buildings) {
      const kept = reuse ? old.get(b.id) : undefined;
      if (kept && sameShape(kept.b, b)) {
        old.delete(b.id);
        kept.b = b;
        // `topX`/`topZ` are in the building's own local frame (see `info`), so
        // they survive the move untouched; only the group's anchor changes.
        kept.group.position.set(b.x, ctx.world.buildingBaseY, b.z);
        next.set(b.id, kept);
        continue;
      }
      if (kept) {
        old.delete(b.id);
        this.disposeEntry(kept);
      }
      const group = new Group();
      group.userData.buildingId = b.id;
      this.group.add(group);
      const e: Entry = { b, group, glow: [], spin: null, top: 0, topX: 0, topZ: 0, bounce: 0, style: oldStyles.get(b.id) ?? {}, model: null, modelUri: null };
      next.set(b.id, e);
      this.buildOne(e);
    }
    for (const e of old.values()) this.disposeEntry(e);
    old.clear();
    this.entries = next;
  }

  /** Removes one building's group from the scene and releases its geometries. */
  private disposeEntry(e: Entry): void {
    this.group.remove(e.group);
    clearGroup(e.group);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  /** Applies (or clears with `null`) a style override. Returns false for unknown ids. */
  setStyle(id: string, style: BuildingStyle | null): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    e.style = style ? overrideFromStyle(style) : {};
    if (style) this.styleMap.set(id, e.style);
    else this.styleMap.delete(id);
    if (!e.style.modelUri) { e.model = null; e.modelUri = null; }
    this.buildOne(e);
    e.bounce = 0.3;
    if (e.style.modelUri && e.modelUri !== e.style.modelUri) this.loadReplacement(e, e.style.modelUri);
    return true;
  }

  /**
   * Hides (or shows) every extruded building. The 2D view sets this once the
   * transition is over: with the group invisible three skips the whole subtree,
   * so the thousands of building draw calls and the shadow pass over them cost
   * nothing at all — collapsing them to zero height would still submit them.
   */
  setHidden(hidden: boolean): void {
    this.group.visible = !hidden;
  }

  /** True while the extruded buildings are hidden (the flat view draws the footprints instead). */
  private get hidden(): boolean {
    return !this.group.visible;
  }

  /** Short squash-and-stretch feedback (e.g. on press). */
  bounce(id: string): void {
    const e = this.entries.get(id);
    if (e) e.bounce = 0.35;
  }

  info(id: string): BuildingInfo | null {
    const e = this.entries.get(id);
    if (!e) return null;
    const v = new Vector3(e.topX, e.top, e.topZ);
    e.group.updateMatrixWorld();
    v.applyMatrix4(e.group.matrixWorld);
    return { id, top: { x: v.x, y: v.y, z: v.z }, model: e.b };
  }

  /**
   * The style overrides in force, by building id — the live map, so the flat
   * renderer can read it once per rebuild without allocating.
   */
  get styles(): ReadonlyMap<string, BuildingOverride> {
    return this.styleMap;
  }

  /**
   * The building whose footprint contains a ground point, or `null`.
   *
   * This is how a press is resolved in the 2D view: the extruded meshes are
   * hidden there (and collapsed to zero height, so a ray would graze a
   * degenerate prism), while the flat layer is a handful of merged meshes with
   * no per-building identity. A ground point against the footprints costs one
   * linear scan per press — never per frame — and gives the same answer the
   * 2.5D raycast would for a tap on a roof.
   */
  pickAt(x: number, z: number): { id: string; point: Vector3 } | null {
    for (const e of this.entries.values()) {
      const b = e.b;
      if (!pointInPolygon(x, z, b.footprint)) continue;
      return { id: b.id, point: new Vector3(x, this.ctx?.world.buildingBaseY ?? 0, z) };
    }
    return null;
  }

  /** First building hit by a ray. */
  pick(raycaster: Raycaster): { id: string; point: Vector3 } | null {
    const hits = raycaster.intersectObject(this.group, true);
    for (const h of hits) {
      let o: Object3D | null = h.object;
      while (o && o.userData.buildingId === undefined) o = o.parent;
      if (o) return { id: o.userData.buildingId as string, point: h.point.clone() };
    }
    return null;
  }

  /**
   * True while a building still needs frames: a running tap bounce, a
   * spinning landmark or a pulsing captured glow. Computed by {@link step},
   * so it describes the frame that was just stepped.
   */
  get animating(): boolean {
    return this._animating;
  }

  /** Per-frame animation: bounce, zoom-out height scale, landmark spin, captured glow. */
  step(dt: number, t: number, scaleY: number, reduceMotion: boolean): void {
    // Nothing here is visible in the flat view, and a spinning landmark or a pulsing captured glow
    // that nobody can see must not keep the on-demand render loop awake.
    if (this.hidden) {
      this._animating = false;
      return;
    }
    const k = 0.28 + (reduceMotion ? 0 : Math.sin(t * 3) * 0.14);
    let animating = false;
    for (const e of this.entries.values()) {
      if (e.bounce > 0 && !reduceMotion) {
        e.bounce = Math.max(0, e.bounce - dt);
        e.group.scale.y = scaleY * (1 + Math.sin((1 - e.bounce / 0.35) * Math.PI) * 0.09);
        animating = true;
      } else {
        e.bounce = 0;
        e.group.scale.y = scaleY;
      }
      if (e.spin && !reduceMotion) {
        e.spin.rotation.y += dt * 1.8;
        animating = true;
      }
      for (const m of e.glow) {
        m.emissive.setHex(GLOW_COLOR);
        m.emissiveIntensity = k;
      }
      // With reduced motion the glow is a constant, so it only needs the frame that applied it.
      if (e.glow.length && !reduceMotion) animating = true;
    }
    this._animating = animating;
  }

  dispose(): void {
    clearGroup(this.group);
    this.entries.clear();
    this.styleMap.clear();
  }

  // -------------------------------------------------------------------------

  private loadReplacement(e: Entry, uri: string): void {
    let p = this.modelCache.get(uri);
    if (!p) {
      p = this.loadModel(uri);
      this.modelCache.set(uri, p);
      p.catch(() => this.modelCache.delete(uri));
    }
    p.then((scene) => {
      if (e.style.modelUri !== uri || this.entries.get(e.b.id) !== e) return;
      e.model = scene.clone(true);
      e.modelUri = uri;
      this.buildOne(e);
      this.onModelLoaded?.(e.b.id);
    }).catch((err) => {
      if (e.style.modelUri === uri) this.onModelError?.(e.b.id, uri, err);
    });
  }

  private localRing(b: BuildingModel): Vec2[] {
    if (b.rect) return rectRing(0, 0, b.rect.w, b.rect.d);
    const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
    return normalizeRing(b.footprint.map(([x, z]) => {
      const dx = x - b.x, dz = z - b.z;
      return [dx * c - dz * s, dx * s + dz * c] as Vec2;
    }));
  }

  private buildOne(e: Entry): void {
    const ctx = this.ctx!;
    const { params: P, mats, tex } = ctx;
    const b = e.b, st = e.style, g = e.group;
    clearGroup(g);
    e.glow = [];
    e.spin = null;
    g.position.set(b.x, ctx.world.buildingBaseY, b.z);
    g.rotation.y = b.yaw;
    const br = mulberry32(b.idx * 977 + 13);
    const cap = st.state === 'captured';
    const fstyle = P.facadeSet;
    const shaded = fstyle === 'real' || fstyle === 'modern' || fstyle === 'urban';
    const mlike = fstyle === 'modern' || fstyle === 'urban';
    const olw = 0.07;
    const glowable = <T extends Material>(m: T): T => {
      if (cap) e.glow.push(m as unknown as MeshStandardMaterial);
      return m;
    };
    const ring = this.localRing(b);
    const bb = bbox(ring);

    // contact shadow decal
    const aoMat = mats.cached('ao', () => mats.basic({ color: 0x000000, map: tex.ao, transparent: true, opacity: P.shading === 'toon' ? 0.2 : 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    const fw = b.landmark ? Math.min(bb.maxX - bb.minX, bb.maxZ - bb.minZ) * 0.95 : bb.maxX - bb.minX;
    const fd = b.landmark ? fw : bb.maxZ - bb.minZ;
    const ao = new Mesh(new PlaneGeometry(fw * 1.78, fd * 1.78).rotateX(-Math.PI / 2), aoMat);
    ao.position.set((bb.minX + bb.maxX) / 2, 0.006, (bb.minZ + bb.maxZ) / 2);
    ao.renderOrder = 1;
    ao.raycast = noRaycast;
    g.add(ao);

    let top = 0, tx = 0, tz = 0;
    let topMass: Mass | null = null;
    let flat = true;
    const hvac = mats.cached('hvac', () => mats.make(0xb4b7bb, { roughness: 0.6, metalness: 0.2 }));
    const pole = mats.cached('pole', () => mats.make(0xe8e8e8, { roughness: 0.5 }));

    if (e.model) {
      const model = e.model;
      model.position.set(0, 0, 0);
      model.scale.setScalar(1);
      model.rotation.set(0, 0, 0);
      const box = new Box3().setFromObject(model), size = box.getSize(new Vector3());
      const s = Math.min((bb.maxX - bb.minX) / Math.max(1e-3, size.x), (bb.maxZ - bb.minZ) / Math.max(1e-3, size.z));
      model.scale.setScalar(s);
      const c = box.getCenter(new Vector3());
      model.position.set((bb.minX + bb.maxX) / 2 - c.x * s, -box.min.y * s, (bb.minZ + bb.maxZ) / 2 - c.z * s);
      model.traverse((o) => { const m = o as Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
      g.add(model);
      top = size.y * s;
      tx = (bb.minX + bb.maxX) / 2;
      tz = (bb.minZ + bb.maxZ) / 2;
    } else if (b.landmark) {
      const L = P.preset.landmark, r = fw * 0.46 / 0.95;
      const mk = (c: number, ex: Parameters<MaterialFactory['make']>[1]): Material => glowable(mats.make(c, ex));
      const glassTex = L.glass === 'urban' ? tex.glassBandU : L.glass === 'modern' ? tex.glassBandM : tex.glassBand;
      addPart(ctx, g, new CylinderGeometry(r, r * 1.05, 1.0, 32).translate(0, 0.5, 0), mk(L.base, { roughness: 0.8 }), { occluder: true, receive: true, outline: olw });
      for (let k = 0; k < 6; k++) {
        const glass = !!L.glass && k % 2 === 0;
        addPart(ctx, g, new CylinderGeometry(r * 0.72, r * 0.72, 1.0, 32).translate(0, 1.5 + k, 0), mk(k % 2 ? L.b : L.a, glass ? { map: glassTex, roughness: 0.25, metalness: 0.3 } : { roughness: 0.7 }), { occluder: true, receive: true, outline: k === 0 ? olw : 0 });
      }
      addPart(ctx, g, new CylinderGeometry(r * 0.95, r * 0.95, 0.3, 32).translate(0, 7.15, 0), mk(L.base, { roughness: 0.8 }), { occluder: true, outline: olw });
      addPart(ctx, g, new ConeGeometry(r * 0.82, 2.6, 32).translate(0, 8.6, 0), mk(L.cone, { roughness: 0.45, metalness: 0.3 }), { occluder: true, outline: olw });
      const gold = mats.cached('gold', () => mats.make(0xffc93c, { roughness: 0.35, metalness: 0.35 }));
      const star = addPart(ctx, g, new OctahedronGeometry(0.5, 0), gold, { outline: 0 });
      star.position.y = 10.4;
      e.spin = star;
      top = 10.9;
    } else {
      const facadeOn = P.facadeOn && st.facade !== false;
      const explicitKinds = ctx.world.kind === 'data' || ctx.world.kind === 'tiles';
      const ukey = b.h * P.heightScale > 6.5 || b.kind === 'glass' ? 'glass' : explicitKinds ? b.kind : (['office', 'apartment', 'glass', 'brick'] as const)[b.idx % 4]!;
      const fk = (fstyle === 'real' ? b.kind : fstyle === 'modern' ? 'm_' + MODERN_MAP[b.kind] : fstyle === 'urban' ? 'u_' + URBAN_MAP[ukey] : fstyle === 'soft' ? 'soft' : 'toy') as FacadeKey;
      const F = tex.facade[fk];
      const glassy = fk === 'glass' || fk === 'm_glass' || fk === 'u_glass';
      const extra = facadeOn
        ? { map: F.tex, emissiveMap: F.lit, roughness: glassy ? (mlike ? 0.22 : 0.25) : mlike ? 0.6 : 0.88, metalness: glassy ? 0.3 : 0, vertexColors: shaded }
        : { roughness: mlike ? 0.7 : 0.9, vertexColors: shaded };
      const scheme = URBAN_SCHEMES[b.idx % URBAN_SCHEMES.length]!;
      const col = st.color ?? cssHexToNumber(fstyle === 'urban' && P.details ? scheme.tint : P.palette[b.ci % P.palette.length]!);
      const mat = cap ? glowable(mats.make(col, { ...extra, emissiveMap: null })) : mats.cached(['wall', col, fk, facadeOn].join('|'), () => mats.make(col, extra));
      const uo = br() * 4, vo = Math.floor(br() * 4) * 0.25;
      const massing = st.massing ?? P.massing;
      const shape: MassShape = massing === 'varied' ? b.autoShape : 'box';
      const H = b.h * P.heightScale;
      const masses = b.rect ? rectMasses(b, shape, H) : polygonMasses(ring, shape, H);
      const boxShape = shape === 'box';
      const roof = st.roof ?? b.roof, roofSet = st.roof !== undefined;
      flat = !boxShape || !b.rect || roof === 'flat' || (P.flatRoofs && !roofSet);
      const detailOn = P.details && shaded;
      const bands: BufferGeometry[] = [], trims: BoxSpec[] = [], rails: BoxSpec[] = [];
      const crownM = masses.reduce((a, c) => (c.bridge ? a : c.y + c.h > a.y + a.h ? c : a), masses[0]!);
      let topY = -1;
      topMass = masses[0]!;
      const decos = st.decos ?? b.decos;

      masses.forEach((m, mi) => {
        const band = shaded && facadeOn && m.y === 0 && !m.bridge && m.h > 1.2 ? 0.42 : 0;
        const bh = m.h - band, y0 = m.y + band;
        if (fstyle === 'soft') {
          const bev = Math.max(0.01, Math.min(0.2, bh * 0.2, Math.min(m.w, m.d) * 0.12));
          const sg = softMassGeometry(m.ring, y0, bh, bev, offsetRing(m.ring, -bev));
          const capM = mats.cached('softcap' + col, () => mats.make(mixHex(col, 0xffffff, 0.4), { roughness: 0.95 }));
          addPart(ctx, g, sg, [capM, mat], { receive: true, occluder: true, outline: 0 });
        } else {
          const geo = prismGeometry(m.ring, y0, bh, { U: F.U, V: F.V, uOffset: uo + mi * 0.37, vOffset: vo, vBase: m.y }, shaded ? { bottom: m.y === 0 ? 0.74 : 0.9 } : null);
          addPart(ctx, g, geo, mat, { receive: true, occluder: true, outline: olw });
        }
        if (detailOn && !m.bridge) {
          const fl = 0.375, u = fk.replace(/^[mu]_/, ''), top0 = m.y + m.h;
          const bandRing = (off: number, y: number, h: number): void => { bands.push(ringBandGeometry(offsetRing(m.ring, off), offsetRing(m.ring, -0.005), y - h / 2, h)); };
          if (u === 'glass') {
            for (let y = y0 + fl * 4; y < top0 - 0.3; y += fl * 4) bandRing(0.025, y, 0.035);
            const fh = bh + (m === crownM ? 0.38 : 0), fy = y0 + fh / 2;
            for (const ed of edgesOf(m.ring)) {
              if (ed.L < 1.2) continue;
              for (let s = 0.25; s <= ed.L - 0.2; s += 0.5) trims.push([0.03, fh, 0.08, ed.ax + ed.ux * s + ed.nx * 0.04, fy, ed.az + ed.uz * s + ed.nz * 0.04, ed.yaw]);
            }
          } else if (u === 'panel' || u === 'office' || u === 'band') {
            for (let y = y0 + fl * 2; y < top0 - 0.2; y += fl * 2) bandRing(0.02, y, 0.03);
            for (const ed of longEdges(m)) for (let s = 0.375; s < ed.L; s += 0.75) trims.push([0.06, bh, 0.1, ed.ax + ed.ux * s + ed.nx * 0.05, y0 + bh / 2, ed.az + ed.uz * s + ed.nz * 0.05, ed.yaw]);
          } else if (u === 'grid' || u === 'resi' || u === 'apartment') {
            for (const ed of longEdges(m)) {
              const bw = ed.L * 0.82;
              for (let y = y0 + fl; y < top0 - 0.15; y += fl) {
                trims.push([bw, 0.03, 0.2, ed.mx + ed.nx * 0.1, y, ed.mz + ed.nz * 0.1, ed.yaw]);
                rails.push([bw, 0.12, 0.012, ed.mx + ed.nx * 0.195, y + 0.075, ed.mz + ed.nz * 0.195, ed.yaw]);
              }
            }
          } else {
            for (let y = y0 + fl; y < top0 - 0.15; y += fl) bandRing(0.08, y, 0.025);
          }
          if (m.h > 1.5 && flat) bands.push(ringBandGeometry(offsetRing(m.ring, 0.05), offsetRing(m.ring, -0.07), top0, 0.07));
          if (band) {
            const front = edgesOf(m.ring).sort((a, c) => c.L - a.L || c.mz - a.mz)[0];
            if (front) trims.push([Math.min(front.L * 0.55, 1.8), 0.04, 0.38, front.mx + front.nx * 0.19, band + 0.03, front.mz + front.nz * 0.19, front.yaw]);
          }
        }
        if (band) {
          const sg = wallsGeometry(offsetRing(m.ring, 0.02), 0, band, { U: 2.0, V: band, uOffset: uo, vOffset: 0, vBase: 0 });
          const storeMat = mats.cached(mlike ? 'storeM' : 'store', () => mats.make(0xffffff, { map: mlike ? tex.storeM : tex.store, emissiveMap: mlike ? tex.storeMLit : tex.storeLit, emissiveScale: 0.9, roughness: mlike ? 0.35 : 0.55 }));
          addPart(ctx, g, sg, storeMat, { occluder: true, receive: true, outline: 0 });
        }

        const mt = m.y + m.h;
        let rt: number;
        const bw = b.rect?.w ?? m.w, bd = b.rect?.d ?? m.d;
        if (boxShape && !flat && roof === 'gable') {
          const along = bw >= bd, span = (along ? bd : bw) + 0.3, len = (along ? bw : bd) + 0.3, rh = span * 0.42;
          const sh = new Shape();
          sh.moveTo(-span / 2, 0); sh.lineTo(span / 2, 0); sh.lineTo(0, rh); sh.lineTo(-span / 2, 0);
          const rg = new ExtrudeGeometry(sh, { depth: len, bevelEnabled: false }).translate(0, 0, -len / 2);
          if (along) rg.rotateY(Math.PI / 2);
          rg.translate(0, H, 0);
          const rm = fstyle === 'real' ? mats.cached('tiles', () => mats.make(0xffffff, { map: tex.roofTiles, roughness: 0.85 }))
            : mlike ? mats.cached('mroof', () => mats.make(0x6b7078, { roughness: 0.5, metalness: 0.3 }))
            : mats.make(offsetHslHex(col, 0, 0.1, -0.16), { roughness: 0.8 });
          addPart(ctx, g, rg, rm, { occluder: true, outline: olw, receive: true });
          rt = H + rh;
        } else if (boxShape && !flat && roof === 'dome') {
          const r = Math.min(bw, bd) * 0.42;
          addPart(ctx, g, new CylinderGeometry(r, r, 0.3, 24).translate(0, H + 0.15, 0), mats.make(mixHex(col, 0xffffff, 0.4)), { occluder: true, outline: olw });
          addPart(ctx, g, new SphereGeometry(r, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, H + 0.3, 0), shaded ? mats.make(0x8e9aa3, { roughness: 0.4, metalness: 0.45 }) : mats.make(offsetHslHex(col, 0, 0.1, -0.16)), { occluder: true, outline: olw });
          rt = H + 0.3 + r;
        } else {
          rt = this.flatRoof(ctx, g, m, mt, br, col, olw, decos.garden, b.kind, hvac);
        }
        if (!m.bridge && rt > topY) { topY = rt; topMass = m; }
      });
      top = topY;
      tx = topMass.x;
      tz = topMass.z;
      if (bands.length || trims.length) {
        const trimColor = fstyle === 'urban' ? scheme.trim : fstyle === 'real' ? 0xbdb8ae : 0xedebe6;
        const parts = [...bands];
        if (trims.length) parts.push(mergeBoxes(trims));
        addPart(ctx, g, mergeFlat(parts), mats.cached('trim' + trimColor, () => mats.make(trimColor, { roughness: 0.45, metalness: fstyle === 'urban' ? 0.35 : 0.05 })), { outline: 0, receive: true, occluder: true });
      }
      if (rails.length) addPart(ctx, g, mergeBoxes(rails), mats.cached('rail', () => mats.basic({ color: 0xcfe3ea, transparent: true, opacity: 0.4, depthWrite: false })), { outline: 0, cast: false });

      const m0 = masses[0]!;
      if (decos.sign) {
        const front = edgesOf(m0.ring).sort((a, c) => c.L - a.L || c.mz - a.mz)[0];
        if (front) {
          const sw = Math.min(front.L * 0.8, 2.6), band0 = shaded && facadeOn && m0.h > 1.2 ? 0.42 : 0, sy = band0 ? band0 + 0.35 : Math.min(1.35, m0.h * 0.55);
          const signMat = mats.cached('sign', () => mats.make(0xffffff, { map: tex.sign, roughness: 0.6 }));
          addPart(ctx, g, mergeBoxes([[sw, sw * 0.28, 0.14, front.mx + front.nx * 0.09, sy, front.mz + front.nz * 0.09, front.yaw]]), signMat, { outline: 0.05 });
        }
      }
      const tm = topMass as Mass;
      if (decos.antenna) {
        let ax = tx + (flat ? tm.w * 0.25 : 0), az = tz + (flat ? -tm.d * 0.2 : 0);
        if (!pointInPolygon(ax, az, tm.ring)) { ax = tx; az = tz; }
        const ant = mats.cached('ant', () => mats.make(0xe0505f));
        addPart(ctx, g, new CylinderGeometry(0.04, 0.04, 1.5, 6).translate(ax, top + 0.75, az), pole, { outline: 0.03 });
        addPart(ctx, g, new SphereGeometry(0.12, 10, 8).translate(ax, top + 1.52, az), ant, { outline: 0.04 });
      }
      if (decos.garden) {
        if (flat) {
          for (const [sx, sz] of [[-0.25, -0.2], [0.22, 0.18], [-0.1, 0.28]] as const) {
            const x = tx + tm.w * sx, z = tz + tm.d * sz;
            if (pointInPolygon(x, z, tm.ring)) tree(ctx, g, x, top, z, 0.55, br);
          }
        } else if (b.rect) {
          for (const [sx, sz] of [[1, 1], [-1, 1]] as const) tree(ctx, g, sx * (b.rect.w / 2 + 0.35), 0, sz * (b.rect.d / 2 + 0.35), 0.5, br);
        }
      }
    }
    e.top = top;
    e.topX = tx;
    e.topZ = tz;
    if (cap) {
      const flag = mats.cached('flag', () => mats.make(ACCENT, { roughness: 0.7 }));
      addPart(ctx, g, new CylinderGeometry(0.05, 0.05, 2.4, 6).translate(tx, top + 1.2, tz), pole, { outline: 0.03 });
      addPart(ctx, g, new BoxGeometry(1.25, 0.72, 0.05).translate(tx + 0.66, top + 1.98, tz), flag, { outline: 0.05 });
    }
  }

  private flatRoof(ctx: RenderContext, g: Group, m: Mass, top: number, br: () => number, col: number, olw: number, garden: boolean, kind: BuildingKind, hvac: Material): number {
    const { params: P, mats, tex } = ctx;
    const kindSet = P.facadeSet;
    const ring = m.ring;
    if (kindSet === 'soft') {
      if (!m.bridge && Math.min(m.w, m.d) > 1.6 && br() < 0.4) {
        const inside = pointInPolygon(m.x, m.z, ring) ? insideRadius(ring, m.x, m.z) : 0;
        const r = m.rect ? Math.min(m.w, m.d) * 0.3 : Math.min(Math.min(m.w, m.d) * 0.3, inside * 0.8);
        if (r > 0.2) {
          const dome = mats.cached('softDome', () => mats.make(0xfffdf8, { roughness: 0.9 }));
          addPart(ctx, g, new SphereGeometry(r, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.6, 1).translate(m.x, top - 0.02, m.z), dome, { outline: 0, occluder: true, receive: true });
        }
      }
      return top + 0.02;
    }
    const inner = (d: number): Vec2[] => offsetRing(ring, d);
    const fitBox = (w: number, d: number, x: number, z: number): boolean => m.rect || fits(ring, x, z, w, d);
    if (kindSet === 'real') {
      const gravel = mats.cached('gravel', () => mats.make(0xffffff, { map: tex.gravel, roughness: 1 }));
      addPart(ctx, g, prismGeometry(inner(-0.01), top, 0.06, null, null, 0.45), gravel, { occluder: true, outline: 0, receive: true });
      const pm = mats.cached('parapet', () => mats.make(0xb0aba2, { roughness: 0.9 }));
      addPart(ctx, g, ringBandGeometry(ring, inner(-0.12), top, 0.2), pm, { occluder: true, outline: 0, receive: true });
      const rt = top + 0.06;
      if (!garden && !m.bridge) {
        const boxes: BoxSpec[] = [];
        if (kind === 'glass') {
          const w = m.w * 0.42, d = m.d * 0.36, x = m.x + m.w * 0.1, z = m.z - m.d * 0.12;
          if (fitBox(w, d, x, z)) addPart(ctx, g, new BoxGeometry(w, 0.55, d).translate(x, rt + 0.275, z), hvac, { occluder: true, outline: 0, receive: true });
        }
        const n = 1 + Math.floor(br() * 3);
        for (let k = 0; k < n; k++) {
          const sx = 0.35 + br() * 0.5, sz = 0.3 + br() * 0.4;
          const x = m.x + (br() - 0.5) * (m.w - 1.2), z = m.z + (br() - 0.5) * (m.d - 1.2);
          if (fitBox(sx, sz, x, z)) boxes.push([sx, 0.3, sz, x, rt + 0.15, z]);
        }
        if (boxes.length) addPart(ctx, g, mergeBoxes(boxes), hvac, { outline: 0, receive: true });
      }
      return rt;
    }
    if (kindSet === 'modern' || kindSet === 'urban') {
      const membrane = mats.cached('membrane', () => mats.make(0xc7c9c6, { roughness: 0.95 }));
      addPart(ctx, g, prismGeometry(inner(-0.01), top, 0.04), membrane, { occluder: true, outline: 0, receive: true });
      const pm = mats.cached('mparapet', () => mats.make(0xf1f0ec, { roughness: 0.8 }));
      addPart(ctx, g, ringBandGeometry(ring, inner(-0.07), top, 0.12), pm, { occluder: true, outline: 0, receive: true });
      const rt = top + 0.04;
      if (m.bridge || m.w < 1.3 || m.d < 1.3 || garden) return rt;
      const pick = br();
      if (pick < 0.4) {
        const dw = m.w * 0.5, dd = m.d * 0.45, dx = m.x - m.w * 0.12, dz = m.z + m.d * 0.1;
        if (fitBox(dw, dd, dx, dz)) {
          const deck = kindSet === 'urban' ? mats.cached('deckU', () => mats.make(0x8e9295, { roughness: 0.85 })) : mats.cached('deck', () => mats.make(0xa7815f, { roughness: 0.8 }));
          addPart(ctx, g, new BoxGeometry(dw, 0.03, dd).translate(dx, rt + 0.015, dz), deck, { outline: 0, receive: true });
        }
        const planter = mats.cached('planter', () => mats.make(0x6f6a64, { roughness: 0.7 }));
        for (let k = 0; k < 2; k++) {
          const px = m.x + (k ? 0.25 : -0.3) * m.w, pz = m.z - m.d * 0.26;
          if (!fitBox(0.34, 0.34, px, pz)) continue;
          addPart(ctx, g, new BoxGeometry(0.34, 0.14, 0.34).translate(px, rt + 0.07, pz), planter, { outline: 0 });
          addPart(ctx, g, new OctahedronGeometry(0.2, 1).translate(px, rt + 0.3, pz), mats.themed('leafA', { roughness: 1 }), { outline: 0 });
        }
      } else if (pick < 0.75) {
        const sm = mats.cached('solar', () => mats.make(0x2c3a52, { roughness: 0.3, metalness: 0.4 }));
        const cols = Math.min(3, Math.max(1, Math.floor((m.w - 0.4) / 0.5))), rows = Math.min(2, Math.max(1, Math.floor((m.d - 0.4) / 0.45)));
        const panels: BufferGeometry[] = [];
        for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
          const x = m.x - (cols - 1) * 0.25 + i * 0.5, z = m.z - (rows - 1) * 0.225 + j * 0.45;
          if (!fitBox(0.42, 0.34, x, z)) continue;
          panels.push(new BoxGeometry(0.42, 0.025, 0.34).rotateX(-0.35).translate(x, rt + 0.12, z).toNonIndexed());
        }
        if (panels.length) addPart(ctx, g, mergeFlat(panels), sm, { outline: 0 });
      } else {
        const w = m.w * 0.35, d = m.d * 0.3, x = m.x + m.w * 0.15, z = m.z - m.d * 0.15;
        if (fitBox(w, d, x, z)) addPart(ctx, g, new BoxGeometry(w, 0.3, d).translate(x, rt + 0.15, z), hvac, { outline: 0, receive: true, occluder: true });
      }
      return rt;
    }
    addPart(ctx, g, prismGeometry(inner(0.12), top, 0.22), mats.make(mixHex(col, 0xffffff, 0.45)), { occluder: true, outline: olw, receive: true });
    return top + 0.22;
  }
}
