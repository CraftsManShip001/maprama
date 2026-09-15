/**
 * Characters: any glTF / GLB avatar (GLTFLoader with Draco and Meshopt
 * support) with conventional clip names `idle|walk|run|ride|wave` or an
 * explicit mapping, cross-faded by speed and travel mode; the prototype's
 * procedural capsule/lathe character as fallback (no model, still loading, or
 * failed to load); vehicles; silhouettes behind buildings; name tags.
 *
 * Models are normalized: feet at the origin, centered, facing +Z (the glTF
 * forward axis), scaled to the procedural character's height (1.9 world
 * units) times `CharacterSpec.scale`.
 *
 * @module
 */

import {
  ANIMATION_NAMES,
  type AnimationName,
  type CharacterSpec,
  type Projection,
  type TravelMode,
  type WorldPoint,
} from '@diorama/protocol';
import {
  AnimationMixer,
  Box3,
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  LatheGeometry,
  LoopOnce,
  LoopRepeat,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  type AnimationAction,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { CameraController } from '../core/camera.js';
import { ensureLabelStyles } from '../labels/dom-styles.js';
import { overlaps, type Box } from '../labels/index.js';
import { noRaycast, outlineScale } from '../render/parts.js';
import type { SceneApi } from '../scene-api.js';
import { clamp, cssHexToNumber, mixHex, offsetHslHex, wrapDeg } from '../util/math.js';
import { snap } from '../world/graph.js';
import type { WorldModel } from '../world/model.js';
import { Follower, groundYFor, KMH, SPEED, type FollowerBody } from './follower.js';
import { buildVehicles, capsule, stepVehicles, switchVehicle, type PartFn, type VehicleSet } from './vehicles.js';

/** Height of the procedural character in world units (glTF models are scaled to it). */
export const CHARACTER_HEIGHT = 1.9;
const PLAYER_COLOR = 0x3f63d6;
const NPC_COLORS = [0x4e9c84, 0xc25b70, 0xd3a03e, 0x6f63b8, 0x3f86be, 0xa8653a];
const CROSSFADE = 0.25;
/** Default Draco decoder location (only fetched for Draco-compressed models). */
export const DRACO_DECODER_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Resolves conventional animation names to clip names: an explicit mapping
 * wins when the clip exists; otherwise a clip named exactly like the
 * convention, then case-insensitively, then a case-insensitive name segment
 * (`"Armature|Walk"`, `"run_fast"`).
 */
export function resolveClips(clipNames: readonly string[], mapping?: Partial<Record<AnimationName, string>>): Partial<Record<AnimationName, string>> {
  const out: Partial<Record<AnimationName, string>> = {};
  for (const name of ANIMATION_NAMES) {
    const mapped = mapping?.[name];
    if (mapped !== undefined && clipNames.includes(mapped)) { out[name] = mapped; continue; }
    const found = clipNames.find((c) => c === name)
      ?? clipNames.find((c) => c.toLowerCase() === name)
      ?? clipNames.find((c) => c.toLowerCase().split(/[|:/.\s_-]+/).includes(name));
    if (found !== undefined) out[name] = found;
  }
  return out;
}

/** Animation for a mode and speed (world units / s), with fallbacks to available clips. */
export function chooseAnimation(mode: TravelMode, speed: number, available: Partial<Record<AnimationName, string>>): AnimationName | null {
  let want: AnimationName;
  if (mode === 'bike' || mode === 'car') want = 'ride';
  else if (mode === 'plane' || mode === 'subway') want = 'idle';
  else if (speed < 0.05) want = 'idle';
  else want = speed / SPEED.walk > 1.6 ? 'run' : 'walk';
  const chains: Record<AnimationName, AnimationName[]> = { ride: ['ride', 'idle'], run: ['run', 'walk', 'idle'], walk: ['walk', 'run', 'idle'], idle: ['idle'], wave: ['wave', 'idle'] };
  return chains[want].find((n) => available[n] !== undefined) ?? null;
}

/** Heading in degrees clockwise from north for a yaw (`atan2(dx, dz)`, +z south). */
export function headingFromYaw(yaw: number): number {
  const d = (Math.atan2(Math.sin(yaw), -Math.cos(yaw)) * 180) / Math.PI;
  return ((d % 360) + 360) % 360;
}

/** Realistic ground speed in m/s for a playback speed in world units / s. */
export function realSpeedMps(speedUnits: number, mode: TravelMode): number {
  return (speedUnits / SPEED[mode]) * (KMH[mode] / 3.6);
}

/**
 * Name tag anchor relative to the character root (world units): above the
 * head when walking, just above the roof of the car, and above the middle car
 * of the subway ghost train (its cars trail behind the character), so the tag
 * stays on the vehicle while riding. `vehicleScale` is the vehicle pop-in
 * scale (0..1).
 */
export function nameTagAnchor(mode: TravelMode, yaw: number, scale = 1, vehicleScale = 1): { dx: number; dy: number; dz: number } {
  if (mode === 'subway' && vehicleScale > 0.55) {
    const back = SUBWAY_MIDDLE_CAR_Z * vehicleScale * scale;
    return { dx: Math.sin(yaw) * back, dy: SUBWAY_TAG_HEIGHT * vehicleScale * scale, dz: Math.cos(yaw) * back };
  }
  return { dx: 0, dy: (mode === 'car' ? 2.0 : 2.3) * scale, dz: 0 };
}

/** Local z of the ghost train's middle car (see `buildVehicles`) and the tag height over it. */
const SUBWAY_MIDDLE_CAR_Z = -2.2;
const SUBWAY_TAG_HEIGHT = 1.25;

const hashId = (id: string): number => {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
};

// ---------------------------------------------------------------------------
// glTF loading
// ---------------------------------------------------------------------------

let loader: GLTFLoader | null = null;
const gltfCache = new Map<string, Promise<GLTF>>();

/** Loads (and caches) a glTF / GLB. */
export function loadModel(uri: string): Promise<GLTF> {
  let p = gltfCache.get(uri);
  if (!p) {
    if (!loader) {
      loader = new GLTFLoader();
      const draco = new DRACOLoader();
      draco.setDecoderPath(DRACO_DECODER_PATH);
      loader.setDRACOLoader(draco);
      loader.setMeshoptDecoder(MeshoptDecoder);
    }
    const l = loader;
    p = new Promise<GLTF>((resolve, reject) => l.load(uri, resolve, undefined, reject));
    p.catch(() => gltfCache.delete(uri));
    gltfCache.set(uri, p);
  }
  return p;
}

/** Clones a loaded scene (skinned meshes keep their own skeleton) and marks it as model content. */
export function instantiateModel(gltf: GLTF): Object3D {
  const obj = cloneSkinned(gltf.scene);
  obj.traverse((o) => {
    o.userData.model = true;
    const m = o as Mesh;
    if (m.isMesh) { m.castShadow = true; m.raycast = noRaycast; }
  });
  return obj;
}

/**
 * Normalizes a model inside a wrapper group: centered on x/z, feet (min y) at
 * 0, scaled so its height (or its largest extent with `byMaxExtent`) is `size`.
 */
export function normalizeModel(obj: Object3D, size: number, byMaxExtent = false): Group {
  const wrap = new Group();
  wrap.add(obj);
  obj.updateMatrixWorld(true);
  const box = new Box3().setFromObject(obj);
  const s3 = box.getSize(new Vector3());
  const ref = byMaxExtent ? Math.max(s3.x, s3.y, s3.z) : s3.y;
  if (ref > 1e-6 && Number.isFinite(ref)) obj.scale.multiplyScalar(size / ref);
  obj.updateMatrixWorld(true);
  const b2 = new Box3().setFromObject(obj);
  if (!b2.isEmpty()) {
    const c = b2.getCenter(new Vector3());
    obj.position.x -= c.x;
    obj.position.z -= c.z;
    obj.position.y -= b2.min.y;
  }
  wrap.userData.model = true;
  return wrap;
}

// ---------------------------------------------------------------------------
// Procedural character
// ---------------------------------------------------------------------------

const shared = <T extends BufferGeometry>(g: T): T => {
  g.userData.shared = true;
  return g;
};

let GEO: Record<string, BufferGeometry> | null = null;
function geos(): Record<string, BufferGeometry> {
  if (!GEO) {
    const torso = [[0, 0], [0.17, 0.012], [0.205, 0.09], [0.19, 0.24], [0.225, 0.44], [0.215, 0.55], [0.15, 0.62], [0.07, 0.655], [0, 0.66]].map((p) => new Vector2(Math.max(0.0001, p[0]!), p[1]!));
    GEO = {
      torso: shared(new LatheGeometry(torso, 16).scale(1, 1, 0.72)),
      neck: shared(new CylinderGeometry(0.055, 0.06, 0.12, 8)),
      head: shared(new SphereGeometry(0.17, 20, 16).scale(1, 1.12, 1.04)),
      hair: shared(new SphereGeometry(0.182, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.52).scale(1, 1.12, 1.08)),
      cap: shared(new SphereGeometry(0.188, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.46).scale(1, 1.05, 1.06)),
      brim: shared(new CylinderGeometry(0.13, 0.13, 0.025, 16, 1, false, -Math.PI / 2, Math.PI).scale(1, 1, 1.1)),
      eye: shared(new SphereGeometry(0.022, 8, 6)),
      thigh: shared(capsule(0.085, 0.28).translate(0, -0.225, 0)),
      shin: shared(capsule(0.07, 0.3).translate(0, -0.22, 0)),
      shoe: shared(new BoxGeometry(0.13, 0.08, 0.26).translate(0, -0.445, 0.05)),
      upper: shared(capsule(0.062, 0.18).translate(0, -0.15, 0)),
      fore: shared(capsule(0.052, 0.17).translate(0, -0.13, 0)),
      hand: shared(new SphereGeometry(0.058, 10, 8).translate(0, -0.29, 0.01)),
      pack: shared(new BoxGeometry(0.28, 0.32, 0.13)),
      silProxy: shared(capsule(0.32, CHARACTER_HEIGHT - 0.64, 12).translate(0, CHARACTER_HEIGHT / 2, 0)),
    };
  }
  return GEO;
}

interface ProceduralRig {
  rig: Group;
  hips: Group[];
  knees: Group[];
  shoulders: Group[];
  elbows: Group[];
}

interface ModelState {
  wrap: Group;
  mixer: AnimationMixer;
  clips: Partial<Record<AnimationName, string>>;
  actions: Partial<Record<AnimationName, AnimationAction>>;
  current: AnimationName | null;
}

/** A live character. Implements the follower body (positions in world units). */
export class Character implements FollowerBody {
  x = 0;
  y = 0;
  z = 0;
  speed = 0;
  yaw = Math.PI / 2;
  targetYaw = Math.PI / 2;
  planePitch = 0;
  mode: TravelMode = 'walk';
  phase: number;
  readonly root = new Group();
  readonly follower: Follower;
  vehicles: VehicleSet | null = null;
  procedural: ProceduralRig | null = null;
  model: ModelState | null = null;
  tag: HTMLDivElement | null = null;
  /** Measured tag size in CSS pixels (0 until measured) and the text it was measured for. */
  tagSize = { w: 0, h: 0, text: '' };
  /** Materials this character owns (disposed on removal). */
  readonly owned: Material[] = [];
  /** Model uri currently shown or loading. */
  modelUri: string | null = null;
  private loadToken = 0;

  constructor(public spec: CharacterSpec, private readonly mgr: CharacterManager, groundY: number) {
    this.phase = (hashId(spec.id) % 1000) / 160;
    this.follower = new Follower(this, groundY);
    this.root.name = `character:${spec.id}`;
    this.y = groundY;
  }

  get id(): string {
    return this.spec.id;
  }

  get color(): number {
    return this.spec.color ? cssHexToNumber(this.spec.color) : this.spec.isPlayer ? PLAYER_COLOR : NPC_COLORS[hashId(this.spec.id) % NPC_COLORS.length]!;
  }

  setMode(mode: TravelMode): boolean {
    if (this.mode === mode) return false;
    this.mode = mode;
    if (mode !== 'walk' && !this.vehicles) this.vehicles = this.mgr.buildVehiclesFor(this);
    if (this.vehicles) switchVehicle(this.vehicles, mode);
    return true;
  }

  /** Mode used for animation / reported speed. */
  get activeMode(): TravelMode {
    return this.follower.mode ?? 'walk';
  }

  /** Starts loading `uri` (or shows the procedural body when `null`). */
  setModel(uri: string | null): void {
    if (uri === this.modelUri && (this.model || uri === null)) return;
    this.modelUri = uri;
    const token = ++this.loadToken;
    if (!uri) { this.dropModel(); this.mgr.ensureProcedural(this); return; }
    this.mgr.ensureProcedural(this);
    loadModel(uri).then((gltf) => {
      if (token !== this.loadToken || this.mgr.disposed) return;
      this.attachModel(gltf);
    }, (err: unknown) => {
      if (token !== this.loadToken || this.mgr.disposed) return;
      this.mgr.reportModelError(this.id, uri, err);
    });
  }

  private attachModel(gltf: GLTF): void {
    this.dropModel();
    const wrap = normalizeModel(instantiateModel(gltf), CHARACTER_HEIGHT);
    const mixer = new AnimationMixer(wrap);
    const clips = resolveClips(gltf.animations.map((c) => c.name), this.spec.animations);
    const actions: Partial<Record<AnimationName, AnimationAction>> = {};
    for (const name of ANIMATION_NAMES) {
      const clipName = clips[name];
      const clip = clipName !== undefined ? gltf.animations.find((c) => c.name === clipName) : undefined;
      if (!clip) continue;
      const a = mixer.clipAction(clip);
      a.setLoop(name === 'wave' ? LoopOnce : LoopRepeat, Infinity);
      actions[name] = a;
    }
    this.model = { wrap, mixer, clips, actions, current: null };
    this.root.add(wrap);
    const sil = new Mesh(geos().silProxy!, this.mgr.silhouetteMaterial(this));
    sil.name = 'silhouette-proxy';
    wrap.add(sil);
    this.mgr.scene.silhouette.addSilhouette(sil);
    if (this.procedural) this.procedural.rig.visible = false;
  }

  private dropModel(): void {
    if (!this.model) return;
    this.model.mixer.stopAllAction();
    this.root.remove(this.model.wrap);
    this.model = null;
    if (this.procedural) this.procedural.rig.visible = true;
  }

  /** Plays a one-shot wave (glTF `wave` clip) if available. */
  wave(): void {
    const a = this.model?.actions.wave;
    if (a) { a.reset(); a.play(); }
  }

  animate(dt: number, t: number, reduceMotion: boolean): void {
    let diff = this.targetYaw - this.yaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    this.yaw += diff * (reduceMotion ? 1 : Math.min(1, dt * 10));
    this.root.rotation.y = this.yaw;
    this.root.position.set(this.x, this.y, this.z);
    const mode = this.mode, sp = this.speed;
    if (this.vehicles) stepVehicles(this.vehicles, mode, sp, dt, t, this.planePitch, reduceMotion);
    const veh = this.vehicles && mode !== 'walk' ? this.vehicles[mode] : null;
    const hideBody = !!veh && mode !== 'bike' && veh.group.visible && veh.p > 0.55;
    const onBike = mode === 'bike' && !!veh && veh.p > 0.4;
    if (this.model) {
      const m = this.model;
      m.wrap.visible = !hideBody;
      m.wrap.position.set(0, onBike ? 0.32 : 0, onBike ? -0.17 : 0);
      const want = chooseAnimation(onBike || mode === 'car' ? mode : 'walk', sp, m.clips);
      if (want !== m.current) {
        const next = want ? m.actions[want] : undefined;
        const prev = m.current ? m.actions[m.current] : undefined;
        if (next) { next.reset(); next.enabled = true; next.play(); if (prev) prev.crossFadeTo(next, reduceMotion ? 0 : CROSSFADE, false); else next.fadeIn(reduceMotion ? 0 : CROSSFADE); }
        else if (prev) prev.fadeOut(CROSSFADE);
        m.current = want;
      }
      const cur = m.current ? m.actions[m.current] : undefined;
      if (cur && (m.current === 'walk' || m.current === 'run')) cur.timeScale = clamp(sp / (m.current === 'run' ? SPEED.walk * 2 : SPEED.walk), 0.5, 2.2);
      m.mixer.update(dt);
      return;
    }
    const r = this.procedural;
    if (!r) return;
    const rig = r.rig;
    rig.visible = !hideBody;
    rig.rotation.set(0, 0, 0);
    rig.position.set(0, 0, 0);
    rig.scale.y = 1;
    if (onBike && this.vehicles) {
      this.phase += dt * sp * 1.3;
      if (this.vehicles.bike.crank) this.vehicles.bike.crank.rotation.x = this.phase;
      rig.position.set(0, 0.02, -0.17);
      rig.rotation.x = 0.32;
      for (let s = 0; s < 2; s++) {
        const w = Math.sin(this.phase + s * Math.PI);
        r.hips[s]!.rotation.x = -1.2 + w * 0.38;
        r.knees[s]!.rotation.x = 1.25 - w * 0.45;
        r.shoulders[s]!.rotation.x = -1.05;
        r.elbows[s]!.rotation.x = -0.25;
      }
    } else if (mode !== 'car') {
      const k = sp / SPEED.walk, amp = Math.min(k, 1), run = clamp((k - 1.2) / 0.8, 0, 1);
      if (sp < 0.05) {
        for (let s = 0; s < 2; s++) {
          r.hips[s]!.rotation.x = 0;
          r.knees[s]!.rotation.x = 0.02;
          r.shoulders[s]!.rotation.x = reduceMotion ? 0 : Math.sin(t * 1.6 + s) * 0.03;
          r.elbows[s]!.rotation.x = -0.12;
        }
        rig.scale.y = 1 + (reduceMotion ? 0 : Math.sin(t * 2.4 + this.phase) * 0.01);
      } else {
        this.phase += dt * sp * (2.3 - run * 0.5);
        for (let s = 0; s < 2; s++) {
          const a = this.phase + s * Math.PI, sn = Math.sin(a), cs = Math.cos(a);
          r.hips[s]!.rotation.x = sn * (0.5 + run * 0.35) * amp;
          r.knees[s]!.rotation.x = (0.1 + Math.max(0, -cs) * (0.9 + run * 0.6)) * amp;
          r.shoulders[s]!.rotation.x = -sn * (0.45 + run * 0.3) * amp;
          r.elbows[s]!.rotation.x = -(0.2 + run * 1.0) * amp - 0.1;
        }
        rig.rotation.y = Math.sin(this.phase) * 0.06 * amp;
        rig.position.y = (0.025 - Math.abs(Math.sin(this.phase)) * 0.04) * amp;
        rig.rotation.x = run * 0.22;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export interface CharacterManagerOptions {
  onModelError(id: string, uri: string, err: unknown): void;
}

/** Owns every character. */
export class CharacterManager {
  readonly group = new Group();
  readonly chars = new Map<string, Character>();
  disposed = false;
  private skin: Material | null = null;
  private vehicleMats: { tire: Material; chrome: Material; glassDark: Material } | null = null;
  private readonly eye = new MeshBasicMaterial({ color: 0x1e1a24 });

  constructor(readonly scene: SceneApi, private readonly options: CharacterManagerOptions) {
    this.group.name = 'characters';
  }

  /** The player character (`isPlayer`), if any. */
  player(): Character | null {
    for (const c of this.chars.values()) if (c.spec.isPlayer) return c;
    return null;
  }

  get(id: string): Character | undefined {
    return this.chars.get(id);
  }

  /** Adds or updates characters (fields of an existing character are merged; `model: null` restores the default avatar). */
  upsert(specs: readonly CharacterSpec[], world: WorldModel, proj: Projection): Character[] {
    const players = new Set([...this.chars.values()].filter((c) => c.spec.isPlayer).map((c) => c.id));
    for (const s of specs) {
      if (s.isPlayer === true) players.add(s.id);
      else if (s.isPlayer === false) players.delete(s.id);
    }
    if (players.size > 1) throw Object.assign(new Error(`at most one character can be the player (got ${[...players].join(', ')})`), { code: 'invalid_character' });
    const out: Character[] = [];
    const gy = groundYFor(world.kind);
    for (const s of specs) {
      let ch = this.chars.get(s.id);
      const fresh = !ch;
      if (!ch) {
        ch = new Character({ ...s }, this, gy);
        this.chars.set(s.id, ch);
        this.group.add(ch.root);
        const p = s.position ? proj.toWorld(s.position) : this.spawnPoint(world, ch);
        ch.x = p.x;
        ch.z = p.z;
      } else {
        const prevColor = ch.color, prevPlayer = !!ch.spec.isPlayer;
        ch.spec = { ...ch.spec, ...s };
        if (s.position) {
          const p = proj.toWorld(s.position);
          ch.follower.setTrip([]);
          ch.x = p.x;
          ch.z = p.z;
        }
        if (ch.color !== prevColor || !!ch.spec.isPlayer !== prevPlayer) this.rebuildProcedural(ch);
      }
      ch.root.scale.setScalar(ch.spec.scale ?? 1);
      ch.setModel(ch.spec.model?.uri ?? null);
      if (fresh) ch.root.position.set(ch.x, ch.y, ch.z);
      if (!ch.spec.showNameTag && ch.tag) { ch.tag.remove(); ch.tag = null; }
      if (ch.tag) ch.tag.textContent = ch.spec.name ?? ch.id;
      out.push(ch);
    }
    return out;
  }

  remove(ids: readonly string[]): Character[] {
    const out: Character[] = [];
    for (const id of ids) {
      const ch = this.chars.get(id);
      if (!ch) continue;
      this.chars.delete(id);
      this.disposeCharacter(ch);
      out.push(ch);
    }
    return out;
  }

  /** Spawn: the plaza (snapped to a road), else the road point nearest the world origin (procedural: start). */
  spawnPoint(world: WorldModel, ch: Character): WorldPoint {
    const base = world.kind === 'data' ? (world.plaza ? { x: world.plaza.x, z: world.plaza.z } : { x: 0, z: 0 }) : world.start;
    let p = { x: base.x, z: base.z };
    if (!ch.spec.isPlayer && this.chars.size > 1) {
      const h = hashId(ch.id);
      p = { x: base.x + ((h % 1000) / 1000 - 0.5) * 30, z: base.z + (((h >>> 10) % 1000) / 1000 - 0.5) * 30 };
    }
    const s = snap(world.graph, p.x, p.z);
    return s ? { x: s.x, z: s.z } : p;
  }

  /** Re-projects positions after the world (projection) changed and stops trips. */
  rebase(oldProj: Projection, newProj: Projection, world: WorldModel): void {
    const gy = groundYFor(world.kind);
    for (const ch of this.chars.values()) {
      const p = newProj.toWorld(oldProj.toLngLat({ x: ch.x, z: ch.z }));
      ch.follower.setTrip([]);
      ch.follower.groundY = gy;
      ch.x = p.x;
      ch.z = p.z;
      ch.y = gy;
    }
  }

  step(dt: number, t: number): void {
    const rm = this.scene.reduceMotion;
    for (const ch of this.chars.values()) {
      ch.follower.step(dt);
      if (!ch.follower.active && ch.mode !== 'walk' && ch.follower.wait <= 0) ch.setMode('walk');
      ch.animate(dt, t, rm);
    }
  }

  /**
   * Positions name tags (DOM) every frame. A tag over a HUD `exclusions` box
   * (map UI such as attribution, scale bar, zoom buttons, and the screen
   * margins) is hidden instead of drawn over it.
   */
  updateTags(cam: CameraController, zoomOut: number, layer: HTMLElement, exclusions: readonly Box[] = []): void {
    for (const ch of this.chars.values()) {
      if (!ch.spec.showNameTag) continue;
      if (!ch.tag) {
        const doc = layer.ownerDocument;
        ensureLabelStyles(doc);
        ch.tag = doc.createElement('div');
        ch.tag.className = 'dio-tag' + (ch.spec.isPlayer ? ' me' : '');
        if (ch.spec.isPlayer && ch.spec.color) ch.tag.style.setProperty('--tag', ch.spec.color);
        ch.tag.textContent = ch.spec.name ?? ch.id;
        layer.appendChild(ch.tag);
      }
      const riding = ch.vehicles && ch.mode !== 'walk' ? ch.vehicles[ch.mode] : null;
      const a = nameTagAnchor(ch.mode, ch.yaw, ch.spec.scale ?? 1, riding?.group.visible ? riding.p : 0);
      const s = cam.worldToScreen(ch.x + a.dx, ch.y + a.dy, ch.z + a.dz);
      const d = cam.camera.position.distanceTo(new Vector3(ch.x, ch.y, ch.z));
      let vis = s.visible && d < 95 && zoomOut < 0.6;
      if (vis && exclusions.length) {
        const text = ch.tag.textContent ?? '';
        if (!ch.tagSize.w || ch.tagSize.text !== text) {
          const w = ch.tag.offsetWidth, h = ch.tag.offsetHeight;
          // not laid out yet (hidden or no DOM layout): estimate from the text
          ch.tagSize = w > 0 ? { w, h, text } : { w: 14 + [...text].length * 12, h: 20, text: '' };
        }
        const box: Box = { x: s.x, y: s.y - ch.tagSize.h / 2, hw: ch.tagSize.w / 2, hh: ch.tagSize.h / 2 };
        if (exclusions.some((e) => overlaps(e, box))) vis = false;
      }
      ch.tag.style.display = vis ? '' : 'none';
      if (vis) ch.tag.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, -100%)`;
    }
  }

  /** Toggles outline meshes after a theme change. */
  applyOutline(on: boolean): void {
    this.group.traverse((o) => { if (o.userData.outline) o.visible = on; });
  }

  /** Clears theme-bound material caches (meshes were converted by the engine). */
  onThemeChange(): void {
    this.skin = null;
    this.vehicleMats = null;
  }

  // ---- internals used by Character ----

  reportModelError(id: string, uri: string, err: unknown): void {
    this.options.onModelError(id, uri, err);
  }

  silhouetteMaterial(ch: Character): MeshBasicMaterial {
    const m = this.scene.silhouette.createMaterial(mixHex(ch.color, 0xffffff, 0.25), 0.9);
    ch.owned.push(m);
    return m;
  }

  ensureProcedural(ch: Character): void {
    if (ch.procedural) return;
    ch.procedural = this.buildProcedural(ch);
    if (ch.model) ch.procedural.rig.visible = false;
  }

  buildVehiclesFor(ch: Character): VehicleSet {
    const vm = this.vehicleMaterials();
    return buildVehicles(ch.root, this.partFn(ch), this.scene.materials, { skin: this.skinMat(), ...vm }, ch.owned);
  }

  private rebuildProcedural(ch: Character): void {
    if (!ch.procedural) return;
    ch.root.remove(ch.procedural.rig);
    disposeTree(ch.procedural.rig);
    ch.procedural = null;
    this.ensureProcedural(ch);
  }

  private skinMat(): Material {
    return (this.skin ??= this.scene.materials.make(0xe8c2a4, { roughness: 0.75 }));
  }

  private vehicleMaterials(): { tire: Material; chrome: Material; glassDark: Material } {
    const m = this.scene.materials;
    return (this.vehicleMats ??= {
      tire: m.make(0x1f2023, { roughness: 0.85 }),
      chrome: m.make(0xc9cdd2, { roughness: 0.3, metalness: 0.6 }),
      glassDark: m.make(0x27313b, { roughness: 0.12, metalness: 0.4 }),
    });
  }

  private partFn(ch: Character): PartFn {
    const silMat = this.silhouetteMaterial(ch);
    const outline = this.scene.params().outline;
    const ink = this.scene.materials.ink;
    const sil = this.scene.silhouette;
    return (parent, geo, mat, x, y, z, ol, noSil = false) => {
      const g = new Group();
      g.position.set(x, y, z);
      parent.add(g);
      const m = new Mesh(geo, mat);
      m.castShadow = true;
      m.raycast = noRaycast;
      g.add(m);
      if (ol) {
        const o = new Mesh(geo, ink);
        outlineScale(o, geo, ol);
        o.userData.outline = true;
        o.visible = outline;
        o.raycast = noRaycast;
        g.add(o);
      }
      if (!noSil) {
        const s = new Mesh(geo, silMat);
        s.raycast = noRaycast;
        g.add(s);
        sil.addSilhouette(s);
      }
      return g;
    };
  }

  private buildProcedural(ch: Character): ProceduralRig {
    const G = geos();
    const M = this.scene.materials;
    const rig = new Group();
    rig.name = 'procedural';
    ch.root.add(rig);
    const P = this.partFn(ch);
    const color = ch.color, isPlayer = !!ch.spec.isPlayer;
    const shirt = M.make(color, { roughness: 0.85 }), pants = M.make(0x2c3342, { roughness: 0.9 });
    const hairM = M.make(0x2a211c, { roughness: 0.7 }), shoes = M.make(0xe6e2da, { roughness: 0.8 });
    const skin = this.skinMat();
    P(rig, G.torso!, shirt, 0, 0.86, 0, 0.022);
    P(rig, G.neck!, skin, 0, 1.56, 0, 0);
    P(rig, G.head!, skin, 0, 1.73, 0, 0.022);
    if (isPlayer) {
      const capM = M.make(offsetHslHex(color, 0, 0, -0.1), { roughness: 0.8 });
      P(rig, G.cap!, capM, 0, 1.76, -0.005, 0.02);
      P(rig, G.brim!, capM, 0, 1.775, 0.12, 0.015);
      P(rig, G.pack!, M.make(0x3a3f47, { roughness: 0.8 }), 0, 1.2, -0.18, 0.02);
    } else P(rig, G.hair!, hairM, 0, 1.745, -0.012, 0.02);
    P(rig, G.eye!, this.eye, -0.062, 1.745, 0.163, 0, true);
    P(rig, G.eye!, this.eye, 0.062, 1.745, 0.163, 0, true);
    const hips: Group[] = [], knees: Group[] = [], shoulders: Group[] = [], elbows: Group[] = [];
    for (const sx of [-0.1, 0.1]) {
      const hp = new Group();
      hp.position.set(sx, 0.9, 0);
      rig.add(hp);
      P(hp, G.thigh!, pants, 0, 0, 0, 0.018);
      const kn = new Group();
      kn.position.set(0, -0.44, 0);
      hp.add(kn);
      P(kn, G.shin!, pants, 0, 0, 0, 0.018);
      P(kn, G.shoe!, shoes, 0, 0, 0, 0.015);
      hips.push(hp);
      knees.push(kn);
    }
    for (const sx of [-0.255, 0.255]) {
      const sh = new Group();
      sh.position.set(sx, 1.46, 0);
      sh.rotation.z = sx < 0 ? -0.08 : 0.08;
      rig.add(sh);
      P(sh, G.upper!, shirt, 0, 0, 0, 0.018);
      const el = new Group();
      el.position.set(0, -0.29, 0);
      sh.add(el);
      P(el, G.fore!, skin, 0, 0, 0, 0.016);
      P(el, G.hand!, skin, 0, 0, 0, 0.014);
      shoulders.push(sh);
      elbows.push(el);
    }
    return { rig, hips, knees, shoulders, elbows };
  }

  private disposeCharacter(ch: Character): void {
    ch.setModel(null);
    this.group.remove(ch.root);
    disposeTree(ch.root);
    for (const m of ch.owned) m.dispose();
    ch.tag?.remove();
    ch.tag = null;
  }

  dispose(): void {
    this.disposed = true;
    for (const ch of [...this.chars.values()]) this.disposeCharacter(ch);
    this.chars.clear();
    this.eye.dispose();
  }
}

/** Disposes geometries of a subtree except shared and model (glTF cache) geometries. */
export function disposeTree(root: Object3D): void {
  root.traverse((o) => {
    const m = o as Mesh;
    if (m.isMesh && !m.geometry.userData.shared && !o.userData.model) m.geometry.dispose();
  });
}

/** Wraps a yaw difference for tests / reporting. */
export const yawDeltaDeg = (a: number, b: number): number => wrapDeg(((b - a) * 180) / Math.PI);

export { Color };
