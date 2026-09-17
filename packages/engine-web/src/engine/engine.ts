/**
 * Engine shell: wires transport ⇄ dispatcher, renderer, camera, gestures,
 * theme, world loading, renderers and the part-1 command / request handlers.
 *
 * @module
 */

import {
  CAMERA_FOV_DEG,
  CAMERA_IDLE_DELAY_MS,
  CAMERA_IDLE_HORIZON_FACTOR,
  INFO_CARD_GROUND_HEIGHT_METERS,
  encodeEvent,
  type CameraIdleEvent,
  type CameraSpec,
  type CameraState,
  type FitBoundsParams,
  type FitBoundsResult,
  type FocusOnParams,
  type FocusOnResult,
  type EngineCommand,
  type EngineEvent,
  type EngineEventType,
  type LabelsSpec,
  type LngLat,
  type LocationSourceKind,
  type MapUiSpec,
  type Projection,
  type SubscriptionTopic,
  type ThemeSpec,
  type TileWorldSource,
  type ViewMode,
  type WorldSource,
} from '@maprama/protocol';
import { Group, type Fog } from 'three';
import { Dispatcher, EngineError, UNSUPPORTED } from '../bridge/dispatcher.js';
import { EventEmitter, type EventListener } from '../bridge/emitter.js';
import type { Transport } from '../bridge/transport.js';
import { CameraController, limitsInUnits, NO_INSET, PITCH_MAX, PITCH_MIN, type FollowTarget } from '../core/camera.js';
import { fitBounds, fitBoundsOrbit, type FitPadding, type FitPoint } from '../core/fit-bounds.js';
import { GestureController } from '../core/gestures.js';
import { RenderCore } from '../core/renderer.js';
import { BuildingRenderer } from '../render/buildings.js';
import type { RenderContext } from '../render/parts.js';
import { FlatBuildings } from '../render/flat-buildings.js';
import { StaticWorldRenderer } from '../render/static-world.js';
import { ViewTransition, viewDurationMs } from '../render/view-mode.js';
import { ZoomOutController } from '../render/zoom-out.js';
import type { SceneApi, SubscriptionHandler } from '../scene-api.js';
import { MaterialFactory } from '../theme/materials.js';
import { MoodOverlays } from '../theme/overlays.js';
import { renderParamsFor, type RenderParams } from '../theme/params.js';
import { createTextures, type TextureSet } from '../theme/textures.js';
import { DEG } from '../util/math.js';
import { route as graphRoute, snap } from '../world/graph.js';
import { resolveWorldSource, WorldLoadError } from '../world/data.js';
import { TileArchiveError } from '../tiles/archive.js';
import { TileWorld } from '../tiles/world.js';
import type { WorldModel } from '../world/model.js';
import { ENGINE_NAME, ENGINE_VERSION } from '../version.js';
import { createRequestHandlers, projectionFor } from './requests.js';
import { Features } from './features.js';
import { routeResult } from '../game/travel.js';
import { groundYFor } from '../game/follower.js';

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

/**
 * Half-width of the square footprint `focusOn` frames around its anchor, as a
 * fraction of the framed height. Half the height keeps a little of the
 * surroundings in view (a bare vertical segment has no width, so the horizontal
 * term of the fit would be degenerate) without pulling the camera so far back
 * that the anchor becomes a dot.
 */
const FOCUS_FOOTPRINT_FACTOR = 0.5;
/** Smallest footprint half-width `focusOn` uses, in world units (a `heightMeters: 0` target still fits). */
const FOCUS_MIN_FOOTPRINT_UNITS = 1;
/**
 * Space `focusOn` keeps free around the framed prism, in dp, on top of
 * `ui.contentInset`: room for the info card's own body, which is drawn in
 * screen pixels above the anchor and therefore not part of the world geometry.
 */
const FOCUS_PADDING_DP = 24;
/**
 * The search starts at least this many times the framed height away.
 *
 * `fitBoundsOrbit` scales the distance by how much the framed box over- or
 * undershoots the viewport, and that step is meaningless while the camera sits
 * *inside* the framed column — the top of the prism is then level with the eye
 * and projects towards infinity, which sends the first step to the far limit
 * and the iteration never recovers. Three times the height puts the camera
 * comfortably above the card at every pitch (the camera's own height is
 * `distance × cos(pitch)`, at worst 0.5 × distance at the 60° pitch cap).
 */
const FOCUS_START_HEIGHT_FACTOR = 3;

/** Error code of the non-fatal event emitted when a requested distance range had to be narrowed. */
export const CAMERA_LIMITS_CLAMPED = 'camera_limits_clamped';

/**
 * Error code of the non-fatal event emitted when a pitch was asked for while
 * the 2D view owns the pitch (see {@link Engine.applyPitch}).
 */
export const VIEW_PITCH_LOCKED = 'view_pitch_locked';

/**
 * Error code of the non-fatal event emitted when one tile of a streamed world
 * could not be read. The map keeps running: a hole in the data is ground, and
 * one unreachable tile is not a reason to take a country-sized map down.
 */
export const TILE_LOAD_FAILED = 'tile_load_failed';

/** Normalises `FitBoundsParams.padding` (dp) to four sides. */
function fitPadding(padding: FitBoundsParams['padding']): FitPadding {
  if (typeof padding === 'number') return { top: padding, right: padding, bottom: padding, left: padding };
  return { top: padding?.top ?? 0, right: padding?.right ?? 0, bottom: padding?.bottom ?? 0, left: padding?.left ?? 0 };
}

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
  /** The streamed tile world, when `init.world.kind` was `tiles`. */
  private tileWorld: TileWorld | null = null;
  /** Set by the tile streamer when a tile arrives outside a frame; consumed by {@link frame}. */
  private tilesDirty = false;
  private proj: Projection = projectionFor(null);
  private readonly staticR = new StaticWorldRenderer();
  private readonly buildingsR = new BuildingRenderer();
  private readonly zoomOut = new ZoomOutController();
  private readonly flatBuildings = new FlatBuildings();
  private readonly view = new ViewTransition();
  /** Flatness applied to the renderers last frame (`-1` = never). */
  private appliedView = -1;
  /** The `view_pitch_locked` warning is emitted once per distinct refused pitch. */
  private warnedPitch = '';
  /** Pitch the 2.5D view is restored to when the flat view is left. */
  private tiltPitch = DEFAULT_ORBIT.pitch;
  private readonly dynamic = new Group();
  private ui: MapUiSpec = {};
  private labels: LabelsSpec = {};
  private locationSource: LocationSourceKind = 'simulated';
  private themeHooks = new Set<(p: RenderParams) => void>();
  private worldHooks = new Set<(w: WorldModel, rebase?: { dx: number; dz: number } | null) => void>();
  private topics = new Map<SubscriptionTopic, SubscriptionHandler>();
  private followResolver: ((id: string) => FollowTarget | null) | null = null;
  private features: Features | null = null;
  private cameraSub: { throttleMs: number; last: number; pending: boolean } | null = null;
  private idleSub: { throttleMs: number; last: number } | null = null;
  /** `performance.now()` at which `camera:idle` becomes due; `Infinity` when nothing is pending. */
  private idleAt = Infinity;
  /** Camera distance limits the app asked for, in meters (converted to world units per world). */
  private limitMeters: { min?: number; max?: number } = {};
  /** The `camera_limits_clamped` warning is emitted once per distinct requested range. */
  private warnedLimits = '';
  /** Active render sources currently held, by tag (see {@link hold}). */
  private readonly holds = new Map<string, () => void>();
  private readonly reduceMotion: boolean;

  constructor(private readonly container: HTMLElement, private readonly options: EngineOptions) {
    // Almost every command changes what is on screen, and the render loop is idle when nothing
    // animates: ask for exactly one frame after each of them. A command can also add, remove or
    // move something that casts a shadow, so the shadow map is invalidated with it.
    this.dispatcher = new Dispatcher((e) => this.emit(e), () => {
      this.core?.requestRender();
      this.core?.requestShadowUpdate();
    });
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
    core.world.add(this.staticR.group, this.buildingsR.group, this.flatBuildings.group, this.zoomOut.mapGroup, this.dynamic);
    this.dynamic.name = 'dynamic';
    this.buildingsR.onModelError = (id, uri, err) => this.emit({ type: 'error', code: 'model_load_failed', message: `building ${id}: failed to load ${uri}: ${err instanceof Error ? err.message : String(err)}`, fatal: false });
    // A late-arriving glTF replacement rebuilds a building outside any frame hook.
    this.buildingsR.onModelLoaded = () => { core.requestRender(); core.requestShadowUpdate(); };

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
    this.cleanups.push(this.cam.onChange(() => {
      if (this.cameraSub) this.cameraSub.pending = true;
      this.armIdle();
    }));
    // Every input path (gestures, wheel, zoom buttons, setCamera) ends in the camera: one frame each.
    // Activity fires *before* the move is applied, which is also what pushes the idle deadline back
    // while an animation or a gesture is still running.
    this.cleanups.push(this.cam.onActivity(() => { core.requestRender(); this.armIdle(); }));
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
    for (const release of this.holds.values()) release();
    this.holds.clear();
    this.features?.dispose();
    this.features = null;
    this.tileWorld?.dispose();
    this.tileWorld = null;
    this.options.transport.close?.();
    this.staticR.clear();
    this.buildingsR.dispose();
    this.flatBuildings.dispose();
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
      this.setUi(cmd.ui);
      this.labels = { ...cmd.labels };
      this.locationSource = cmd.locationSource;
      this.params = renderParamsFor(cmd.theme);
      // The view mode is applied before the camera: a `camera.pitch` in the same `init` as
      // `view: '2d'` is then refused by the same rule as one sent later, instead of tilting a map
      // that is supposed to start flat.
      if (cmd.view) this.setView(cmd.view, false);
      await this.loadWorld(cmd.world);
      if (cmd.camera) this.setCamera(cmd.camera);
    });
    d.register('setView', (cmd) => this.setView(cmd.view, cmd.animate));
    d.register('setTheme', (cmd) => this.setTheme(cmd.theme));
    d.register('setUi', (cmd) => this.setUi(cmd.ui));
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
    d.register('setMarkerLayer', (cmd) => f().setMarkerLayer(cmd));
    d.register('removeMarkerLayer', (cmd) => f().removeMarkerLayer(cmd.layerId));
    d.register('setInfoCard', (cmd) => f().setInfoCard(cmd.card));
    d.register('removeInfoCard', (cmd) => f().removeInfoCard(cmd.id));
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
    this.topics.set('camera:idle', {
      subscribe: (_id, throttleMs) => {
        this.idleSub = { throttleMs, last: -Infinity };
        // Subscribing arms one event: the app gets "this is what is on screen" without having to
        // wait for the user to touch the map first.
        this.armIdle();
      },
      unsubscribe: () => {
        this.idleSub = null;
        this.idleAt = Infinity;
      },
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
    const handlers = createRequestHandlers({
      world: () => this.worldModel,
      view: this.cam,
      roofY: (id) => this.buildingsR.info(id)?.top.y ?? null,
      groundY: () => groundYFor(this.worldModel?.kind),
    });
    d.registerRequest('project', handlers.project);
    d.registerRequest('unproject', handlers.unproject);
    d.registerRequest('snapToRoad', handlers.snapToRoad);
    d.registerRequest('snapToBuilding', handlers.snapToBuilding);
    d.registerRequest('route', ({ from, to, modes }) => {
      if (!this.worldModel) throw new EngineError('not_ready', 'no world loaded (send init first)');
      return routeResult(this.worldModel, this.proj, from, to, modes);
    });
    d.registerRequest('fitBounds', (params) => this.fitBounds(params));
    d.registerRequest('focusOn', (params) => this.focusOn(params));
  }

  private requireScene(): RenderCore {
    if (!this.core) throw new EngineError('webgl_unavailable', 'renderer is not available', true);
    return this.core;
  }

  private async loadWorld(source: WorldSource): Promise<void> {
    this.requireScene();
    let world: WorldModel;
    try {
      world = source.kind === 'tiles' ? await this.openTileWorld(source) : await resolveWorldSource(source);
    } catch (e) {
      if (e instanceof WorldLoadError || e instanceof TileArchiveError) throw new EngineError('world_load_failed', e.message);
      throw e;
    }
    if (this.destroyed) return;
    this.worldModel = world;
    this.proj = projectionFor(world);
    // The limits are meters: a new world's `unitMeters` changes what they are in world units.
    this.applyDistanceLimits();
    this.cam.set({ x: world.start.x, z: world.start.z, ...DEFAULT_ORBIT });
    this.applyTheme();
    for (const h of [...this.worldHooks]) h(world);
  }

  /**
   * Opens a streamed tile world. The archive's header and metadata are read
   * here (one range request); no tile is fetched until the first frame knows
   * where the camera is looking, so `init` does not wait on map data.
   */
  private async openTileWorld(source: TileWorldSource): Promise<WorldModel> {
    this.tileWorld?.dispose();
    this.tileWorld = null;
    const tiles = await TileWorld.open(source, {
      // A tile that arrives while the map is idle has to wake the loop for one
      // frame — and only for one. The loop is never held *waiting* for the
      // network (see `frame`), which is what keeps a static tile map at 0 idle
      // frames like every other world.
      onChange: () => {
        this.tilesDirty = true;
        this.core?.requestRender();
      },
      onWarning: (message) => this.emit({ type: 'error', code: TILE_LOAD_FAILED, message, fatal: false }),
    });
    if (this.destroyed) {
      tiles.dispose();
      throw new WorldLoadError('engine was destroyed while the tile archive was opening');
    }
    this.tileWorld = tiles;
    return tiles.world;
  }

  /**
   * One streaming step for a tile world: which tiles the camera needs, whether
   * the render anchor has to move, and — if either changed — a rebuild.
   *
   * ### Why the re-base is invisible
   *
   * `TileWorld.step` may move the anchor, and it reports the world-unit delta.
   * The delta is applied **here, in one frame, to everything at once**: the
   * camera anchor and any camera transition still running, then the rebuilt
   * geometry (which is assembled around the new anchor), then every world hook
   * (characters and their trips, drops, markers, info cards, geofences, overlay
   * anchors, labels). Since the tile frame's scale is fixed for the life of the
   * world, the move is a pure translation of the whole scene *and* the camera
   * that looks at it, so the rendered image cannot change.
   * `scripts/tile-rebase.mjs` captures the frames on both sides and compares
   * them pixel by pixel.
   */
  private stepTiles(): boolean {
    const tiles = this.tileWorld;
    const core = this.core;
    if (!tiles || !core) return false;
    this.tilesDirty = false;
    const o = this.cam.orbit;
    const corners = this.cam.groundCorners(CAMERA_IDLE_HORIZON_FACTOR * o.distance);
    const step = tiles.step({ x: o.x, z: o.z }, corners);
    // Held only while requests are in flight: waiting for the network must not
    // by itself keep the render loop awake (`scripts/idle-frames.mjs`).
    this.hold('tiles', step.loading);
    if (!step.changed) return false;
    const r = step.rebase;
    if (r) {
      // The camera first, so the rebuilt world and the eye that looks at it
      // move together within this frame.
      this.cam.shift(r.dx, r.dz);
    }
    this.worldModel = tiles.world;
    this.proj = projectionFor(this.worldModel);
    this.applyDistanceLimits();
    this.rebuildWorldGeometry();
    for (const h of [...this.worldHooks]) h(this.worldModel, r);
    core.requestShadowUpdate();
    return true;
  }

  private setTheme(theme: ThemeSpec): void {
    this.params = renderParamsFor(theme);
    this.applyTheme();
  }

  /**
   * `setView` / `init.view`: switches the render view mode.
   *
   * **Nothing else in the engine changes this** — not a zoom threshold, not a
   * device class, not `prefers-reduced-motion` (which only makes the switch
   * instant). The mode is the app's, so a declarative `view="2d"` prop and a
   * `ref.setView()` call never fight each other.
   *
   * ### What owns what while a transition runs
   *
   * The view transition owns the **pitch** and nothing else: it pins the
   * camera's pitch limits to the interpolated value, so a `setCamera`,
   * `fitBounds`, `focusOn` or gesture issued at the same time keeps moving the
   * centre, the distance and the bearing while the tilt follows the mode. A
   * second `setView` mid-transition retargets from where the map is now
   * instead of restarting (`ViewTransition.request`), so tapping the toggle
   * twice reads as one continuous motion.
   */
  private setView(mode: ViewMode, animate: boolean | { durationMs: number } | undefined): void {
    // Entering the flat view from the tilted one records the pitch to come back to: the same value
    // is retraced on the way out, including after a mid-flight reversal.
    if (mode === '2d' && this.view.t === 0) this.tiltPitch = this.cam.orbit.pitch;
    const moving = this.view.request(mode, viewDurationMs(animate), this.reduceMotion);
    this.applyView();
    this.core?.requestRender();
    this.core?.requestShadowUpdate();
    // `animating: true` goes out at the start so an app can swap its own 2D chrome immediately;
    // the settled event is emitted by `frame` when `t` lands (or right here for an instant switch).
    this.emit({ type: 'view:change', view: mode, animating: moving && this.view.animating });
  }

  /**
   * Applies the current flatness to everything that is not per-frame animation:
   * the camera's pitch window and the shadow pass. The renderers (buildings,
   * flat layer, fog, clutter) are driven from {@link frame}, which has the
   * frame's `dt`.
   */
  private applyView(): void {
    const t = this.view.t;
    this.appliedView = t;
    // Pitch: free in 2.5D, pinned to the interpolated value from the first frame of a transition
    // on. `setPitchLimits` re-clamps the current pitch and any running camera transition's target.
    if (t > 0) {
      const pitch = this.tiltPitch * (1 - t);
      this.cam.setPitchLimits(pitch, pitch);
    } else this.cam.setPitchLimits(PITCH_MIN, PITCH_MAX);
    this.overlays?.setViewFlat(t);
    const core = this.core;
    if (!core) return;
    // Shadows exist to make height readable. A flat map has no height, and turning the pass off is
    // where a large part of the 2D view's frame cost goes (see `scripts/view-cost.mjs`).
    core.sun.castShadow = this.params.shadows && !this.view.flat;
  }

  /** Clamps a requested pitch into the limits in force and reports a refusal once. */
  private applyPitch(requested: number | undefined): number {
    const current = this.cam.orbit.pitch;
    if (requested === undefined) return current;
    const allowed = this.cam.clampPitch(requested);
    if (allowed === requested) {
      this.warnedPitch = '';
      return allowed;
    }
    // Refused, not silently obeyed and not a reason to leave the mode: the app asked for two things
    // that cannot both be true, and the mode it set explicitly outranks a pitch that came along
    // with a camera move. Leaving 2D on its own would also fight a declarative `view="2d"` prop,
    // which would immediately put the engine back. Everything else in the same command is applied.
    const key = `${requested}`;
    if (this.warnedPitch !== key) {
      this.warnedPitch = key;
      this.emit({
        type: 'error',
        code: VIEW_PITCH_LOCKED,
        message:
          `pitch ${requested}° was ignored: the "${this.view.mode}" view keeps the pitch at ${allowed}°. ` +
          'Send setView("2.5d") first (the rest of the command was applied).',
        fatal: false,
      });
    }
    return allowed;
  }

  /**
   * Rebuilds the world's geometry for a **world that changed under an unchanged
   * theme** — which is what a tile arriving, a tile dropping or a re-base is.
   *
   * This is deliberately not {@link applyTheme}. `applyTheme` starts a new
   * material generation and drops the old one, re-applies lights, fog,
   * overlays and the view, and hands the renderers a world they must rebuild
   * from nothing — all of it correct for `setTheme`, and all of it wasted on a
   * tile change, where the lights, the fog and the materials are the ones
   * already in force. Keeping the material generation is also what lets the
   * building renderer **reuse** the meshes of every building that did not
   * change (`BuildingRenderer.build(ctx, true)`), which is where the cost of a
   * tile change actually was.
   */
  private rebuildWorldGeometry(): void {
    const core = this.core;
    const world = this.worldModel;
    if (!core || !world || !this.tex) return;
    const ctx: RenderContext = { params: this.params, mats: this.mats, tex: this.tex, world };
    this.staticR.build(ctx);
    this.buildingsR.build(ctx, true);
    this.zoomOut.buildOverlay(world, this.mats);
    // The overlay's materials are new objects, so the opacity and visibility
    // the current zoom-out factor implies have to be written to them again.
    this.zoomOut.invalidate();
    // The flat layer is merged geometry over the whole world: a changed world
    // means it has to be merged again (lazily, only if the view still wants it).
    this.flatBuildings.invalidate();
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
    // The flat layer's materials belong to the generation `disposeOld` is about to drop, and its
    // fills come from the theme palette: rebuild it (lazily, and only if the view still needs it).
    this.flatBuildings.invalidate();
    // `core.applyTheme` just wrote `sun.castShadow = params.shadows`; the view mode may say no.
    this.appliedView = -1;
    this.applyView();
    for (const h of [...this.themeHooks]) h(p);
    disposeOld();
  }

  /**
   * Applies a `MapUiSpec`. The only part the engine shell owns is
   * `contentInset`: it moves the camera anchor (and with it what `setCamera`,
   * `follow`, `fitBounds` and `camera:idle` mean by "the centre"), while the
   * ornaments read the spec again in `Features.project`.
   */
  private setUi(ui: MapUiSpec): void {
    this.ui = { ...ui };
    this.cam.setInset(ui.contentInset);
  }

  private setCamera(spec: CameraSpec): void {
    // Limits first: a spec that widens the range and moves out in one command must not be
    // clamped by the range it is replacing.
    if (spec.minDistanceMeters !== undefined || spec.maxDistanceMeters !== undefined) {
      if (spec.minDistanceMeters !== undefined) this.limitMeters.min = spec.minDistanceMeters;
      if (spec.maxDistanceMeters !== undefined) this.limitMeters.max = spec.maxDistanceMeters;
      this.applyDistanceLimits();
    }
    const o: { x?: number; z?: number; distance?: number; pitch?: number; bearing?: number } = {};
    if (spec.center) {
      const w = this.proj.toWorld(spec.center);
      o.x = w.x;
      o.z = w.z;
    }
    if (spec.distance !== undefined) o.distance = this.proj.metersToUnits(spec.distance);
    else if (spec.zoom !== undefined) o.distance = this.proj.metersToUnits(this.zoomToMeters(spec.zoom, spec.center?.lat ?? this.proj.origin.lat));
    // A pitch is only honoured while the 2.5D view owns it; in 2D it is refused with one
    // `view_pitch_locked` and the rest of the spec still applies (see `applyPitch`).
    if (spec.pitch !== undefined) o.pitch = this.applyPitch(spec.pitch);
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

  /**
   * Puts {@link limitMeters} in force for the current world, converting meters
   * to world units with the world's `unitMeters`. A range the renderer cannot
   * serve is narrowed to what it can and reported once as a non-fatal error.
   */
  private applyDistanceLimits(): void {
    const u = this.proj.unitMeters;
    const { min: wantMin, max: wantMax } = limitsInUnits(this.limitMeters, u);
    const eff = this.cam.setDistanceLimits(wantMin, wantMax);
    const key = `${wantMin}/${wantMax}/${u}`;
    if (!eff.clamped || this.warnedLimits === key) {
      if (!eff.clamped) this.warnedLimits = '';
      return;
    }
    this.warnedLimits = key;
    const m = (units: number): string => `${Math.round(units * u)} m`;
    this.emit({
      type: 'error',
      code: CAMERA_LIMITS_CLAMPED,
      message:
        `camera distance range ${m(wantMin)}–${m(wantMax)} is outside what this engine can render at ` +
        `${u} m per world unit; using ${m(eff.min)}–${m(eff.max)}`,
      fatal: false,
    });
  }

  /** `request{fitBounds}`: frames a geographic box and moves the camera there. */
  private fitBounds(params: FitBoundsParams): FitBoundsResult {
    if (!this.worldModel) throw new EngineError('not_ready', 'no world loaded (send init first)');
    const { ne, sw } = params.bounds;
    const corners = [
      this.proj.toWorld({ lng: sw.lng, lat: sw.lat }),
      this.proj.toWorld({ lng: ne.lng, lat: sw.lat }),
      this.proj.toWorld({ lng: ne.lng, lat: ne.lat }),
      this.proj.toWorld({ lng: sw.lng, lat: ne.lat }),
    ];
    // An explicit pitch / bearing is an instruction, so it turns `auto`'s fallback off.
    const explicit = params.pitch !== undefined || params.bearing !== undefined;
    const limits = this.cam.distanceLimits;
    // The content inset is app chrome over the map, so the box has to fit *beside* it: the inset is
    // added to the request's padding, which is space the app wants free inside the visible area.
    const inset = this.cam.inset;
    const pad = fitPadding(params.padding);
    const out = fitBounds({
      corners,
      width: this.cam.width,
      height: this.cam.height,
      padding: {
        top: pad.top + inset.top,
        right: pad.right + inset.right,
        bottom: pad.bottom + inset.bottom,
        left: pad.left + inset.left,
      },
      fovDeg: CAMERA_FOV_DEG,
      // Clamped before the solver, not after: framing a box for a pitch the camera will not get
      // would report a camera that is not the one the map ends up with. At pitch 0 the fit is also
      // exact on the first step — the visible ground is a rectangle, not a trapezium.
      pitch: this.applyPitch(params.pitch),
      bearing: params.bearing ?? this.cam.orbit.bearing,
      orientation: params.orientation ?? (explicit ? 'keep' : 'auto'),
      minDistance: limits.min,
      maxDistance: limits.max,
      startDistance: this.cam.orbit.distance,
    });
    const ms = params.animate === true ? DEFAULT_ANIMATION_MS : typeof params.animate === 'object' ? params.animate.durationMs : 0;
    this.cam.follow(null);
    // `fitBounds` works in the viewport-centred model; the camera's target is the centre of the
    // *visible* area, so the result is shifted by the inset before it becomes the camera anchor.
    const shift = this.cam.insetShift({ distance: out.distance, pitch: out.pitch, bearing: out.bearing });
    const ax = out.x + shift.x, az = out.z + shift.z;
    this.cam.set({ x: ax, z: az, distance: out.distance, pitch: out.pitch, bearing: out.bearing }, ms);
    return {
      camera: {
        center: this.proj.toLngLat({ x: ax, z: az }),
        distance: this.proj.unitsToMeters(out.distance),
        pitch: out.pitch,
        bearing: ((out.bearing % 360) + 360) % 360,
      },
      fitted: out.fitted,
      distanceLimited: out.distanceLimited,
    };
  }

  /**
   * `request{focusOn}`: frames one point and the column of air above it — where
   * an info card floats — and moves the camera there.
   *
   * It reuses `fitBounds`' geometry rather than inventing a second camera
   * solver: the target becomes a **prism** (a square footprint of
   * `FOCUS_FOOTPRINT_FACTOR × height` around the anchor, from the anchor's own
   * base up to `height`), and `fitBoundsOrbit` frames that prism. Two things
   * fall out of that for free: a vertical extent means the anchor lands in the
   * lower half of the visible area and the card in the upper half, which is
   * exactly where they belong; and the same clamping and `fitted` /
   * `distanceLimited` reporting apply, so `focusOn` behaves like `fitBounds`
   * when the distance limits do not allow what was asked.
   *
   * An explicit `distance` is honoured by pinning the search range to it (still
   * inside the camera limits), so the re-centring step runs unchanged.
   */
  private focusOn(params: FocusOnParams): FocusOnResult {
    if (!this.worldModel) throw new EngineError('not_ready', 'no world loaded (send init first)');
    const target = this.focusTarget(params);
    const useInset = params.inset !== false;
    const inset = useInset ? this.cam.inset : NO_INSET;
    const limits = this.cam.distanceLimits;
    const pitch = this.applyPitch(params.pitch);
    const bearing = params.bearing ?? this.cam.orbit.bearing;
    // A pinned distance is clamped into the camera limits first, then used as the whole search
    // range, so the iteration only re-centres.
    const pinned = params.distance === undefined ? null : this.cam.clampDistance(this.proj.metersToUnits(params.distance));
    const half = Math.max(FOCUS_MIN_FOOTPRINT_UNITS, target.height * FOCUS_FOOTPRINT_FACTOR);
    const corners: FitPoint[] = [];
    for (const y of [target.baseY, target.baseY + target.height]) {
      corners.push(
        { x: target.x - half, z: target.z - half, y },
        { x: target.x + half, z: target.z - half, y },
        { x: target.x + half, z: target.z + half, y },
        { x: target.x - half, z: target.z + half, y },
      );
    }
    const out = fitBoundsOrbit({
      corners,
      width: this.cam.width,
      height: this.cam.height,
      padding: { top: inset.top + FOCUS_PADDING_DP, right: inset.right + FOCUS_PADDING_DP, bottom: inset.bottom + FOCUS_PADDING_DP, left: inset.left + FOCUS_PADDING_DP },
      fovDeg: CAMERA_FOV_DEG,
      pitch,
      bearing,
      minDistance: pinned ?? limits.min,
      maxDistance: pinned ?? limits.max,
      startDistance: pinned ?? Math.max(this.cam.orbit.distance, target.height * FOCUS_START_HEIGHT_FACTOR),
    });
    const ms = params.animate === true ? DEFAULT_ANIMATION_MS : typeof params.animate === 'object' ? params.animate.durationMs : 0;
    this.cam.follow(null);
    // Same frame conversion as `fitBounds`: the solver works viewport-centred, the camera anchor
    // is the centre of the visible area.
    const shift = this.cam.insetShift({ distance: out.distance, pitch: out.pitch, bearing: out.bearing });
    const ax = out.x + shift.x, az = out.z + shift.z;
    this.cam.set({ x: ax, z: az, distance: out.distance, pitch: out.pitch, bearing: out.bearing }, ms);
    return {
      camera: {
        center: this.proj.toLngLat({ x: ax, z: az }),
        distance: this.proj.unitsToMeters(out.distance),
        pitch: out.pitch,
        bearing: ((out.bearing % 360) + 360) % 360,
      },
      fitted: out.fitted,
      // A pinned distance is the app's instruction, so "the limits decided it" means the clamp bit.
      distanceLimited: pinned === null ? out.distanceLimited : pinned !== this.proj.metersToUnits(params.distance!),
    };
  }

  /** Resolves a `focusOn` target to world units: the anchor, its base height and the card height. */
  private focusTarget(params: FocusOnParams): { x: number; z: number; baseY: number; height: number } {
    if (params.infoCardId !== undefined) {
      const anchor = this.features?.infoCardAnchor(params.infoCardId) ?? null;
      if (!anchor) throw new EngineError('unknown_info_card', `unknown info card "${params.infoCardId}"`);
      const height = params.heightMeters === undefined ? anchor.height : this.proj.metersToUnits(params.heightMeters);
      return { x: anchor.x, z: anchor.z, baseY: anchor.baseY, height };
    }
    const p = this.proj.toWorld(params.coordinate!);
    const meters = params.heightMeters ?? INFO_CARD_GROUND_HEIGHT_METERS;
    return { x: p.x, z: p.z, baseY: groundYFor(this.worldModel?.kind), height: this.proj.metersToUnits(meters) };
  }

  /** Web-map zoom → camera distance in meters (vertical view span at the target). */
  private zoomToMeters(zoom: number, lat: number): number {
    const mpp = (156543.03392 * Math.cos(lat * DEG)) / Math.pow(2, zoom);
    const spanMeters = mpp * this.cam.height;
    return spanMeters / 2 / Math.tan((CAMERA_FOV_DEG * DEG) / 2);
  }

  /** Pushes the `camera:idle` deadline back to "the idle delay from now". */
  private armIdle(): void {
    if (this.idleSub) this.idleAt = performance.now() + CAMERA_IDLE_DELAY_MS;
  }

  /**
   * The `camera:idle` payload for the camera as it stands.
   *
   * `bounds` is the north-aligned box around the four ground corners of the
   * visible area, and `radiusMeters` the distance from the reported centre to
   * the farthest of those corners — the circle that holds everything on
   * screen. Corners that run to the horizon are pulled back to
   * `CAMERA_IDLE_HORIZON_FACTOR × distance`, which is the engine's far plane
   * (`farFor`), so the numbers stay finite and describe ground that is really
   * drawn.
   */
  private cameraIdleEvent(): CameraIdleEvent {
    const camera = this.cameraState();
    const o = this.cam.orbit;
    const corners = this.cam.groundCorners(CAMERA_IDLE_HORIZON_FACTOR * o.distance);
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity, maxUnits = 0;
    for (const c of corners) {
      const ll: LngLat = this.proj.toLngLat(c);
      if (ll.lng < minLng) minLng = ll.lng;
      if (ll.lng > maxLng) maxLng = ll.lng;
      if (ll.lat < minLat) minLat = ll.lat;
      if (ll.lat > maxLat) maxLat = ll.lat;
      maxUnits = Math.max(maxUnits, Math.hypot(c.x - o.x, c.z - o.z));
    }
    return {
      type: 'camera:idle',
      camera,
      bounds: { ne: { lng: maxLng, lat: maxLat }, sw: { lng: minLng, lat: minLat } },
      radiusMeters: this.proj.unitsToMeters(maxUnits),
      reason: this.cam.moveReason,
    };
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
    // Streaming runs before anything reads the world: a tile that arrived (or a
    // re-base) is fully applied by the time this frame draws, never half of it.
    if (this.tileWorld) this.stepTiles();
    // The view transition is advanced first: everything below reads its flatness for this frame.
    const wasAnimating = this.view.animating;
    if (this.view.update(dt) || this.appliedView !== this.view.t) this.applyView();
    if (wasAnimating && !this.view.animating) this.emit({ type: 'view:change', view: this.view.mode, animating: false });
    const vt = this.view.t;
    this.zoomOut.update(dt, this.cam.orbit.distance, this.params, {
      fog: core.scene.fog as Fog,
      shadowCamera: core.sun.shadow.camera,
      clutter: this.staticR.clutter,
      setHazeFade: (tt, map) => this.overlays?.setZoomFade(tt, map),
    }, this.reduceMotion, vt);
    // Extruded buildings sink to nothing, then leave the scene graph entirely; the flat layer fades
    // in underneath them. `info()` reads the group's world matrix, so a roof-anchored info card
    // comes down to the ground with them for free.
    // Hidden first, then stepped: `step` skips its animations while hidden, so the frame that
    // leaves the flat view must show the group before it is stepped back to its real height.
    this.buildingsR.setHidden(this.view.flat);
    this.buildingsR.step(dt, t, this.zoomOut.scaleY * (1 - vt), this.reduceMotion);
    this.flatBuildings.update(vt, this.worldModel, this.params, this.mats, this.buildingsR.styles);
    const sub = this.cameraSub;
    if (sub && sub.pending && this.worldModel) {
      const now = performance.now();
      if (now - sub.last >= sub.throttleMs) {
        sub.last = now;
        sub.pending = false;
        this.emit({ type: 'camera:change', camera: this.cameraState() });
      }
    }
    const idle = this.idleSub;
    if (idle && this.worldModel && this.idleAt !== Infinity) {
      const now = performance.now();
      if (now >= this.idleAt) {
        if (now - idle.last >= idle.throttleMs) {
          idle.last = now;
          this.idleAt = Infinity;
          this.emit(this.cameraIdleEvent());
        } else {
          // Inside the throttle window: the camera is still at rest, so try again when it opens.
          this.idleAt = idle.last + idle.throttleMs;
        }
      }
    }
    // Keep the loop awake exactly while the part-1 renderers still animate. A camera subscription
    // that is still pending also needs one more frame to get its throttled event out.
    this.hold('camera', this.cam.animating);
    // Held for the duration of a view transition and released the frame it lands, so a settled 2D
    // map goes back to 0 idle frames exactly like a settled 2.5D one.
    this.hold('view', this.view.animating);
    this.hold('zoomOut', this.zoomOut.animating);
    this.hold('buildings', this.buildingsR.animating);
    // Only while a world is loaded: without one the emit above never runs and `pending` would
    // stay true forever, keeping the loop awake for nothing.
    this.hold('camera:change', !!sub?.pending && !!this.worldModel);
    // Same idea for the idle timer: the loop stays awake for the idle delay after the last move,
    // then emits one event and lets the map go idle again.
    this.hold('camera:idle', this.idleAt !== Infinity && !!idle && !!this.worldModel);
  }

  /** Acquires / releases the active render source `tag` so it is held exactly while `want` is true. */
  private hold(tag: string, want: boolean): void {
    const release = this.holds.get(tag);
    if (want === !!release) return;
    if (want) {
      const core = this.core;
      if (core) this.holds.set(tag, core.addActiveSource(tag));
    } else {
      release!();
      this.holds.delete(tag);
    }
  }

  private tap(x: number, y: number): void {
    if (!this.worldModel) return;
    // Markers come first: a press that hits one emits `marker:press` only.
    if (this.features?.pressMarker(x, y)) return;
    const ground = this.cam.screenToGround(x, y);
    // In the flat view there is no extruded geometry to hit: the press is resolved against the
    // footprints under the ground point, which is what the flat layer actually draws.
    const hit = this.view.flat ? (ground ? this.buildingsR.pickAt(ground.x, ground.z) : null) : this.buildingsR.pick(this.cam.rayAt(x, y));
    if (hit) {
      // The squash-and-stretch feedback is a height animation: in the flat view it would hold a
      // render source for a third of a second and show nothing.
      if (!this.view.flat) {
        this.buildingsR.bounce(hit.id);
        // the bounce starts outside a frame hook, and a squashed building throws a different shadow
        this.core?.requestRender();
        this.core?.requestShadowUpdate();
      }
      this.emit({ type: 'building:press', buildingId: hit.id, coordinate: this.proj.toLngLat({ x: hit.point.x, z: hit.point.z }) });
      return;
    }
    if (ground) this.emit({ type: 'map:press', coordinate: this.proj.toLngLat(ground) });
  }

  private createSceneApi(): SceneApi {
    const core = this.core!;
    const self = this;
    return {
      three: { scene: core.scene, root: core.world, camera: this.cam.camera, renderer: core.renderer },
      groups: { static: this.staticR.group, buildings: this.buildingsR.group, flatBuildings: this.flatBuildings.group, mapOverlay: this.zoomOut.mapGroup, dynamic: this.dynamic },
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
      tileWorld: () => self.tileWorld,
      projection: () => self.proj,
      toWorld: (ll) => self.proj.toWorld(ll),
      toLngLat: (p) => self.proj.toLngLat(p),
      ui: () => self.ui,
      labels: () => self.labels,
      locationSource: () => self.locationSource,
      zoomOutFactor: () => self.zoomOut.t,
      viewMode: () => self.view.mode,
      anchorHeightScale: () => 1 - self.view.t,
      onFrame: (hook) => core.onFrame(hook),
      onBeforeRender: (hook) => core.onBeforeRender(hook),
      // The scene API is how content is changed from outside a frame, so it also invalidates the
      // shadow map. Camera movement does not go through here (see `cam.onActivity` above): the
      // shadow policy compares the shadow camera itself.
      requestRender: () => { core.requestRender(); core.requestShadowUpdate(); },
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
