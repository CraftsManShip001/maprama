/**
 * Engine shell: wires transport ⇄ dispatcher, renderer, camera, gestures,
 * theme, world loading, renderers and the part-1 command / request handlers.
 *
 * @module
 */

import {
  encodeEvent,
  type CameraSpec,
  type CameraState,
  type EngineCommand,
  type EngineEvent,
  type EngineEventType,
  type LabelsSpec,
  type LocationSourceKind,
  type MapUiSpec,
  type Projection,
  type SubscriptionTopic,
  type ThemeSpec,
  type WorldSource,
} from '@maprama/protocol';
import { Group, type Fog } from 'three';
import { Dispatcher, EngineError, UNSUPPORTED } from '../bridge/dispatcher.js';
import { EventEmitter, type EventListener } from '../bridge/emitter.js';
import type { Transport } from '../bridge/transport.js';
import { CameraController, type FollowTarget } from '../core/camera.js';
import { GestureController } from '../core/gestures.js';
import { RenderCore } from '../core/renderer.js';
import { BuildingRenderer } from '../render/buildings.js';
import type { RenderContext } from '../render/parts.js';
import { StaticWorldRenderer } from '../render/static-world.js';
import { ZoomOutController } from '../render/zoom-out.js';
import type { SceneApi, SubscriptionHandler } from '../scene-api.js';
import { MaterialFactory } from '../theme/materials.js';
import { MoodOverlays } from '../theme/overlays.js';
import { renderParamsFor, type RenderParams } from '../theme/params.js';
import { createTextures, type TextureSet } from '../theme/textures.js';
import { DEG } from '../util/math.js';
import { route as graphRoute, snap } from '../world/graph.js';
import { resolveWorldSource, WorldLoadError } from '../world/data.js';
import type { WorldModel } from '../world/model.js';
import { ENGINE_NAME, ENGINE_VERSION } from '../version.js';
import { createRequestHandlers, projectionFor } from './requests.js';
import { Features } from './features.js';
import { routeResult } from '../game/travel.js';

export interface EngineOptions {
  transport: Transport;
}

/** Handle returned by `createEngine`. */
export interface EngineHandle {
  /** Dispatches a command object directly (bypassing the transport). Resolves when handled. */
  dispatch(command: EngineCommand): Promise<void>;
  /** Subscribes to engine events. */
  on<T extends EngineEventType>(type: T, cb: EventListener<T>): () => void;
  on(type: '*', cb: (event: EngineEvent) => void): () => void;
  /** Stops rendering and releases GPU / DOM resources. */
  destroy(): void;
  /** Internal scene API for part-2 modules and tooling (`null` when WebGL is unavailable). Unstable. */
  readonly scene: SceneApi | null;
}

const DEFAULT_ORBIT = { distance: 36, pitch: 50, bearing: 28 };
const DEFAULT_ANIMATION_MS = 600;

export class Engine implements EngineHandle {
  readonly emitter = new EventEmitter();
  readonly dispatcher: Dispatcher;
  scene: SceneApi | null = null;
  private seq = 0;
  private destroyed = false;
  private readonly cleanups: (() => void)[] = [];
  private core: RenderCore | null = null;
  private cam = new CameraController();
  private overlays: MoodOverlays | null = null;
  private mats = new MaterialFactory();
  private tex: TextureSet | null = null;
  private params: RenderParams = renderParamsFor({});
  private worldModel: WorldModel | null = null;
  private proj: Projection = projectionFor(null);
  private readonly staticR = new StaticWorldRenderer();
  private readonly buildingsR = new BuildingRenderer();
  private readonly zoomOut = new ZoomOutController();
  private readonly dynamic = new Group();
  private ui: MapUiSpec = {};
  private labels: LabelsSpec = {};
  private locationSource: LocationSourceKind = 'simulated';
  private themeHooks = new Set<(p: RenderParams) => void>();
  private worldHooks = new Set<(w: WorldModel) => void>();
  private topics = new Map<SubscriptionTopic, SubscriptionHandler>();
  private followResolver: ((id: string) => FollowTarget | null) | null = null;
  private features: Features | null = null;
  private cameraSub: { throttleMs: number; last: number; pending: boolean } | null = null;
  private readonly reduceMotion: boolean;

  constructor(private readonly container: HTMLElement, private readonly options: EngineOptions) {
    // Almost every command changes what is on screen, and the render loop is idle when nothing
    // animates: ask for exactly one frame after each of them.
    this.dispatcher = new Dispatcher((e) => this.emit(e), () => this.core?.requestRender());
    this.cleanups.push(options.transport.onMessage((raw) => { void this.dispatcher.receive(raw); }));
    const win = container.ownerDocument.defaultView;
    this.reduceMotion = !!win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    this.cam.reduceMotion = this.reduceMotion;

    container.classList.add('mpr-root');
    if (win && win.getComputedStyle(container).position === 'static') container.style.position = 'relative';
    if (this.reduceMotion) container.classList.add('mpr-reduce-motion');
    const canvas = container.ownerDocument.createElement('canvas');
    canvas.setAttribute('aria-label', 'Map');
    container.appendChild(canvas);
    this.overlays = new MoodOverlays(container);

    this.registerHandlers();
    try {
      this.core = new RenderCore(canvas, this.cam);
    } catch (e) {
      queueMicrotask(() => this.emit({ type: 'error', code: 'webgl_unavailable', message: `WebGL renderer could not be created: ${e instanceof Error ? e.message : String(e)}`, fatal: true }));
      return;
    }
    const core = this.core;
    core.world.add(this.staticR.group, this.buildingsR.group, this.zoomOut.mapGroup, this.dynamic);
    this.dynamic.name = 'dynamic';
    this.buildingsR.onModelError = (id, uri, err) => this.emit({ type: 'error', code: 'model_load_failed', message: `building ${id}: failed to load ${uri}: ${err instanceof Error ? err.message : String(err)}`, fatal: false });
    // A late-arriving glTF replacement rebuilds a building outside any frame hook.
    this.buildingsR.onModelLoaded = () => core.requestRender();

    const resize = (): void => {
      const r = container.getBoundingClientRect();
      core.resize(r.width, r.height);
    };
    resize();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(resize);
      ro.observe(container);
      this.cleanups.push(() => ro.disconnect());
    } else if (win) {
      win.addEventListener('resize', resize);
      this.cleanups.push(() => win.removeEventListener('resize', resize));
    }

    const gestures = new GestureController(canvas, this.cam, { onTap: (x, y) => this.tap(x, y) });
    this.cleanups.push(() => gestures.dispose());

    this.cam.set(DEFAULT_ORBIT);
    this.cleanups.push(this.cam.onChange(() => { if (this.cameraSub) this.cameraSub.pending = true; }));
    // Every input path (gestures, wheel, zoom buttons, setCamera) ends in the camera: one frame each.
    this.cleanups.push(this.cam.onActivity(() => core.requestRender()));
    core.onFrame((dt, t) => this.frame(dt, t));
    this.scene = this.createSceneApi();
    this.features = new Features(this.scene);
    this.applyTheme();
    core.start();
    queueMicrotask(() => {
      if (!this.destroyed) this.emit({ type: 'ready', engine: { name: ENGINE_NAME, version: ENGINE_VERSION, kind: 'web' } });
    });
  }

  dispatch(command: EngineCommand): Promise<void> {
    return this.dispatcher.dispatch(command);
  }

  on<T extends EngineEventType>(type: T, cb: EventListener<T>): () => void;
  on(type: '*', cb: (event: EngineEvent) => void): () => void;
  on(type: string, cb: (e: never) => void): () => void {
    return (this.emitter.on as (t: string, c: (e: never) => void) => () => void)(type, cb);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const c of this.cleanups.splice(0)) c();
    this.features?.dispose();
    this.features = null;
    this.options.transport.close?.();
    this.staticR.clear();
    this.buildingsR.dispose();
    this.core?.dispose();
    this.mats.dispose();
    this.tex?.dispose();
    this.overlays?.dispose();
    this.core?.renderer.domElement.remove();
    this.emitter.clear();
    this.container.classList.remove('mpr-root', 'mpr-reduce-motion');
  }

  // ---------------------------------------------------------------------------

  private emit(event: EngineEvent): void {
    if (this.destroyed) return;
    this.emitter.emit(event);
    try {
      this.options.transport.send(encodeEvent(event, this.seq++));
    } catch {
      // transport failures must not break the engine
    }
  }

  private registerHandlers(): void {
    const d = this.dispatcher;
    d.register('init', async (cmd) => {
      this.ui = { ...cmd.ui };
      this.labels = { ...cmd.labels };
      this.locationSource = cmd.locationSource;
      this.params = renderParamsFor(cmd.theme);
      await this.loadWorld(cmd.world);
      if (cmd.camera) this.setCamera(cmd.camera);
    });
    d.register('setTheme', (cmd) => this.setTheme(cmd.theme));
    d.register('setUi', (cmd) => { this.ui = { ...cmd.ui }; });
    // ---- part 2 (delegated to Features, which needs the renderer) ----
    const f = (): Features => {
      if (!this.features) throw new EngineError('webgl_unavailable', 'renderer is not available', true);
      return this.features;
    };
    d.register('setLabels', (cmd) => { const feat = f(); this.labels = { ...cmd.labels }; feat.labelsChanged(); });
    d.register('setLabelContent', (cmd) => f().setLabelContent(cmd.entries));
    d.register('upsertCharacters', (cmd) => f().upsertCharacters(cmd.characters));
    d.register('removeCharacters', (cmd) => f().removeCharacters(cmd.ids));
    d.register('setLocationSource', (cmd) => { const feat = f(); this.locationSource = cmd.source; feat.setLocationSource(cmd.source); });
    d.register('pushLocation', (cmd) => f().pushLocation(cmd.fix));
    d.register('travel', (cmd) => f().startTravel(cmd.requestId, cmd.characterId, cmd.to, cmd.modes, cmd.timeScale ?? 1));
    d.register('cancelTravel', (cmd) => f().cancelTravel(cmd.characterId));
    d.register('setDropLayer', (cmd) => f().setDropLayer(cmd));
    d.register('removeDropLayer', (cmd) => f().removeDropLayer(cmd.layerId));
    d.register('setGeofences', (cmd) => f().setGeofences(cmd.geofences));
    d.register('setOverlayAnchors', (cmd) => f().setOverlayAnchors(cmd.anchors));
    for (const topic of ['character:position', 'travel:progress'] as const) {
      this.topics.set(topic, {
        subscribe: (id, throttleMs) => f().topic(topic).subscribe(id, throttleMs),
        unsubscribe: (id) => f().topic(topic).unsubscribe(id),
      });
    }
    d.register('setCamera', (cmd) => this.setCamera(cmd.camera));
    d.register('setBuildingStyle', (cmd) => {
      this.requireScene();
      if (!this.worldModel) throw new EngineError('not_ready', 'no world loaded (send init first)');
      if (!this.buildingsR.setStyle(cmd.buildingId, cmd.style)) throw new EngineError('unknown_building', `unknown building "${cmd.buildingId}"`);
    });
    this.topics.set('camera:change', {
      subscribe: (_id, throttleMs) => { this.cameraSub = { throttleMs, last: -Infinity, pending: true }; },
      unsubscribe: () => { this.cameraSub = null; },
    });
    d.register('subscribe', (cmd) => {
      const h = this.topics.get(cmd.topic);
      if (!h) throw new EngineError(UNSUPPORTED, `subscription topic "${cmd.topic}" is not implemented`);
      h.subscribe(cmd.id, cmd.throttleMs);
    });
    d.register('unsubscribe', (cmd) => {
      const h = this.topics.get(cmd.topic);
      if (!h) throw new EngineError(UNSUPPORTED, `subscription topic "${cmd.topic}" is not implemented`);
      h.unsubscribe(cmd.id);
    });
    const handlers = createRequestHandlers({ world: () => this.worldModel, view: this.cam });
    d.registerRequest('project', handlers.project);
    d.registerRequest('unproject', handlers.unproject);
    d.registerRequest('snapToRoad', handlers.snapToRoad);
    d.registerRequest('route', ({ from, to, modes }) => {
      if (!this.worldModel) throw new EngineError('not_ready', 'no world loaded (send init first)');
      return routeResult(this.worldModel, this.proj, from, to, modes);
    });
  }

  private requireScene(): RenderCore {
    if (!this.core) throw new EngineError('webgl_unavailable', 'renderer is not available', true);
    return this.core;
  }

  private async loadWorld(source: WorldSource): Promise<void> {
    this.requireScene();
    let world: WorldModel;
    try {
      world = await resolveWorldSource(source);
    } catch (e) {
      if (e instanceof WorldLoadError) throw new EngineError('world_load_failed', e.message);
      throw e;
    }
    if (this.destroyed) return;
    this.worldModel = world;
    this.proj = projectionFor(world);
    this.cam.set({ x: world.start.x, z: world.start.z, ...DEFAULT_ORBIT });
    this.applyTheme();
    for (const h of [...this.worldHooks]) h(world);
  }

  private setTheme(theme: ThemeSpec): void {
    this.params = renderParamsFor(theme);
    this.applyTheme();
  }

  /** Applies render params: lights, fog, overlays, materials; rebuilds the static world and buildings. */
  private applyTheme(): void {
    const core = this.core;
    if (!core) return;
    if (!this.tex) this.tex = createTextures({ anisotropy: core.anisotropy });
    const p = this.params;
    const disposeOld = this.mats.beginTheme(p.preset, p.lights);
    core.applyTheme(p);
    this.overlays?.apply(p);
    this.mats.convertTree(this.dynamic);
    if (this.worldModel) {
      const ctx: RenderContext = { params: p, mats: this.mats, tex: this.tex, world: this.worldModel };
      this.staticR.build(ctx);
      this.buildingsR.build(ctx);
      this.zoomOut.buildOverlay(this.worldModel, this.mats);
    }
    this.zoomOut.invalidate();
    for (const h of [...this.themeHooks]) h(p);
    disposeOld();
  }

  private setCamera(spec: CameraSpec): void {
    const o: { x?: number; z?: number; distance?: number; pitch?: number; bearing?: number } = {};
    if (spec.center) {
      const w = this.proj.toWorld(spec.center);
      o.x = w.x;
      o.z = w.z;
    }
    if (spec.distance !== undefined) o.distance = this.proj.metersToUnits(spec.distance);
    else if (spec.zoom !== undefined) o.distance = this.proj.metersToUnits(this.zoomToMeters(spec.zoom, spec.center?.lat ?? this.proj.origin.lat));
    if (spec.pitch !== undefined) o.pitch = spec.pitch;
    if (spec.bearing !== undefined) o.bearing = spec.bearing;
    const ms = spec.animate === true ? DEFAULT_ANIMATION_MS : typeof spec.animate === 'object' ? spec.animate.durationMs : 0;
    if (spec.follow !== undefined) {
      if (spec.follow === null) this.cam.follow(null);
      else {
        const target = this.followResolver?.(spec.follow) ?? null;
        if (!target) throw new EngineError('unknown_character', `cannot follow "${spec.follow}": no such character`);
        this.cam.follow(target, spec.follow);
      }
    }
    if (spec.center && spec.follow === undefined) this.cam.follow(null);
    this.cam.set(o, ms);
  }

  /** Web-map zoom → camera distance in meters (vertical view span at the target). */
  private zoomToMeters(zoom: number, lat: number): number {
    const mpp = (156543.03392 * Math.cos(lat * DEG)) / Math.pow(2, zoom);
    const spanMeters = mpp * this.cam.height;
    return spanMeters / 2 / Math.tan((this.cam.camera.fov * DEG) / 2);
  }

  private cameraState(): CameraState {
    const o = this.cam.orbit;
    return {
      center: this.proj.toLngLat({ x: o.x, z: o.z }),
      distance: this.proj.unitsToMeters(o.distance),
      pitch: o.pitch,
      bearing: ((o.bearing % 360) + 360) % 360,
    };
  }

  private frame(dt: number, t: number): void {
    const core = this.core!;
    this.cam.update(0);
    this.zoomOut.update(dt, this.cam.orbit.distance, this.params, {
      fog: core.scene.fog as Fog,
      shadowCamera: core.sun.shadow.camera,
      clutter: this.staticR.clutter,
      setHazeFade: (tt, map) => this.overlays?.setZoomFade(tt, map),
    }, this.reduceMotion);
    this.buildingsR.step(dt, t, this.zoomOut.scaleY, this.reduceMotion);
    const sub = this.cameraSub;
    if (sub && sub.pending && this.worldModel) {
      const now = performance.now();
      if (now - sub.last >= sub.throttleMs) {
        sub.last = now;
        sub.pending = false;
        this.emit({ type: 'camera:change', camera: this.cameraState() });
      }
    }
  }

  private tap(x: number, y: number): void {
    if (!this.worldModel) return;
    const hit = this.buildingsR.pick(this.cam.rayAt(x, y));
    if (hit) {
      this.buildingsR.bounce(hit.id);
      this.core?.requestRender(); // the bounce starts outside a frame hook
      this.emit({ type: 'building:press', buildingId: hit.id, coordinate: this.proj.toLngLat({ x: hit.point.x, z: hit.point.z }) });
      return;
    }
    const g = this.cam.screenToGround(x, y);
    if (g) this.emit({ type: 'map:press', coordinate: this.proj.toLngLat(g) });
  }

  private createSceneApi(): SceneApi {
    const core = this.core!;
    const self = this;
    return {
      three: { scene: core.scene, root: core.world, camera: this.cam.camera, renderer: core.renderer },
      groups: { static: this.staticR.group, buildings: this.buildingsR.group, mapOverlay: this.zoomOut.mapGroup, dynamic: this.dynamic },
      materials: this.mats,
      textures: () => {
        if (!self.tex) self.tex = createTextures({ anisotropy: core.anisotropy });
        return self.tex;
      },
      camera: this.cam,
      silhouette: core.silhouette,
      overlayLayer: this.overlays!.layer,
      container: this.container,
      reduceMotion: this.reduceMotion,
      frames: () => core.frames,
      params: () => self.params,
      world: () => self.worldModel,
      projection: () => self.proj,
      toWorld: (ll) => self.proj.toWorld(ll),
      toLngLat: (p) => self.proj.toLngLat(p),
      ui: () => self.ui,
      labels: () => self.labels,
      locationSource: () => self.locationSource,
      zoomOutFactor: () => self.zoomOut.t,
      onFrame: (hook) => core.onFrame(hook),
      onBeforeRender: (hook) => core.onBeforeRender(hook),
      requestRender: () => core.requestRender(),
      addActiveSource: (tag) => core.addActiveSource(tag),
      activeSources: () => core.activeSources(),
      onThemeChange: (hook) => {
        self.themeHooks.add(hook);
        return () => { self.themeHooks.delete(hook); };
      },
      onWorldLoad: (hook) => {
        self.worldHooks.add(hook);
        if (self.worldModel) hook(self.worldModel);
        return () => { self.worldHooks.delete(hook); };
      },
      groundAt: (px, py) => self.cam.screenToGround(px, py),
      pickBuilding: (px, py) => self.buildingsR.pick(self.cam.rayAt(px, py)),
      building: (id) => self.buildingsR.info(id),
      snapToRoad: (x, z) => (self.worldModel ? snap(self.worldModel.graph, x, z) : null),
      route: (from, to) => {
        const w = self.worldModel;
        if (!w) return [from, to];
        const a = snap(w.graph, from.x, from.z), b = snap(w.graph, to.x, to.z);
        return a && b ? graphRoute(w.graph, a, b) : [from, to];
      },
      registerCommand: (type, handler) => self.dispatcher.register(type, handler),
      registerRequest: (method, handler) => self.dispatcher.registerRequest(method, handler),
      registerSubscription: (topic, handler) => {
        self.topics.set(topic, handler);
        return () => { if (self.topics.get(topic) === handler) self.topics.delete(topic); };
      },
      registerFollowResolver: (resolver) => {
        self.followResolver = resolver;
        return () => { if (self.followResolver === resolver) self.followResolver = null; };
      },
      emit: (event) => self.emit(event),
      on: (type, cb) => self.emitter.on(type, cb),
    };
  }
}
