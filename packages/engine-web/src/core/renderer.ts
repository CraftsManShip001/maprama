/**
 * Renderer + scene + lights + render loop, including the silhouette pass
 * service (layer 0 normal render, layer 1 depth-only occluders, layer 2
 * silhouettes drawn with `GreaterDepth` behind occluders).
 *
 * ## On-demand rendering
 *
 * The `requestAnimationFrame` loop keeps ticking, but its *body* is gated by a
 * {@link FrameScheduler}: a tick that has neither a pending
 * {@link RenderCore.requestRender} nor a held {@link RenderCore.addActiveSource}
 * only refreshes the timestamp and returns, so a static map costs nothing.
 * Note that the simulation only advances inside {@link RenderCore.step}:
 * anything that has to keep moving must hold a source.
 *
 * @module
 */

import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  Fog,
  GreaterDepth,
  Group,
  HemisphereLight,
  MeshBasicMaterial,
  NoToneMapping,
  PCFShadowMap,
  Scene,
  WebGLRenderer,
  type Object3D,
} from 'three';
import type { RenderParams } from '../theme/params.js';
import type { CameraController } from './camera.js';
import { FrameScheduler } from './frame-scheduler.js';

/** Frame hook: `dt` seconds (clamped to 0.05), `t` total seconds. */
export type FrameHook = (dt: number, t: number) => void;

export const LAYER_DEFAULT = 0;
export const LAYER_OCCLUDER = 1;
export const LAYER_SILHOUETTE = 2;

/** Silhouette-through-buildings service (used by part 2 characters). */
export interface SilhouetteService {
  /** Enables/disables the extra passes. */
  enabled: boolean;
  /** Marks an object (and its meshes) as an occluder (e.g. building walls). */
  addOccluder(obj: Object3D): void;
  /** Puts an object on the silhouette layer only; draw it with {@link createMaterial}. */
  addSilhouette(obj: Object3D): void;
  /** Material that renders only where the object is hidden behind occluders. */
  createMaterial(color: number, opacity?: number): MeshBasicMaterial;
}

export class RenderCore {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly world = new Group();
  readonly hemi = new HemisphereLight(0xffffff, 0xb9c3da, 0.9);
  readonly sun = new DirectionalLight(0xfff3e0, 2.2);
  readonly silhouette: SilhouetteService;
  readonly anisotropy: number;
  sunDir: [number, number, number] = [30, 30, 24];
  frames = 0;
  private hooks = new Set<FrameHook>();
  private renderHooks = new Set<FrameHook>();
  private raf = 0;
  private last = 0;
  private time = 0;
  private running = false;
  private contextLost = false;
  private readonly scheduler = new FrameScheduler();
  private readonly canvas: HTMLCanvasElement;
  private readonly depthOnly = new MeshBasicMaterial({ colorWrite: false });

  constructor(canvas: HTMLCanvasElement, private readonly cam: CameraController) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.canvas = canvas;
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    const r = this.renderer;
    r.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
    r.autoClear = false;
    r.shadowMap.enabled = true;
    r.shadowMap.type = PCFShadowMap;
    this.anisotropy = Math.min(8, r.capabilities.getMaxAnisotropy());

    this.scene.fog = new Fog(0xd9dfe0, 45, 150);
    this.scene.add(this.hemi, this.sun, this.sun.target, this.world);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -48, right: 48, top: 48, bottom: -48, near: 1, far: 160 });
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.03;

    const self = this;
    this.silhouette = {
      enabled: true,
      addOccluder(obj) {
        obj.traverse((o) => o.layers.enable(LAYER_OCCLUDER));
      },
      addSilhouette(obj) {
        obj.traverse((o) => o.layers.set(LAYER_SILHOUETTE));
        self.hasSilhouettes = true;
        // A new silhouette (and the first one, which turns the extra passes on) changes the picture.
        self.requestRender();
      },
      createMaterial(color, opacity = 0.9) {
        return new MeshBasicMaterial({ color, depthFunc: GreaterDepth, depthWrite: false, fog: false, transparent: true, opacity });
      },
    };
  }

  /** Set by {@link SilhouetteService.addSilhouette}; the extra passes are skipped until something uses them. */
  hasSilhouettes = false;

  applyTheme(p: RenderParams): void {
    const r = this.renderer;
    r.toneMapping = p.toneMapped ? ACESFilmicToneMapping : NoToneMapping;
    r.toneMappingExposure = p.exposure;
    r.setClearColor(new Color(p.clearColor));
    const fog = this.scene.fog as Fog;
    fog.color.set(p.fog.color);
    fog.near = p.fog.near;
    fog.far = p.fog.far;
    this.hemi.color.set(p.hemi.sky);
    this.hemi.groundColor.set(p.hemi.ground);
    this.hemi.intensity = p.hemi.intensity;
    this.sun.color.set(p.sun.color);
    this.sun.intensity = p.sun.intensity;
    this.sun.castShadow = p.shadows;
    this.sunDir = p.sun.dir;
    this.requestRender();
  }

  /** Sets the drawing buffer size (CSS pixels). Reallocates the drawing buffer, so it always draws a frame. */
  resize(width: number, height: number): void {
    this.renderer.setSize(Math.max(1, width), Math.max(1, height), false);
    this.cam.setViewport(width, height);
    this.requestRender();
  }

  /**
   * Renders one more frame. Idempotent within a frame: any number of calls
   * between two animation frames produce exactly one extra frame. Call it
   * after changing anything visible from outside a frame hook.
   */
  requestRender(): void {
    this.scheduler.request();
  }

  /**
   * Keeps rendering (and stepping the simulation) until the returned release
   * function is called. Releasing twice is a no-op, and holders of the same
   * `tag` are reference counted, so each holder releases its own hold.
   */
  addActiveSource(tag: string): () => void {
    return this.scheduler.addSource(tag);
  }

  /** Tags currently keeping the loop rendering (diagnostics and tests). */
  activeSources(): string[] {
    return this.scheduler.tags;
  }

  /** True while a frame is queued or a source is held (i.e. the engine is not idle). */
  get busy(): boolean {
    return this.scheduler.busy;
  }

  onFrame(hook: FrameHook): () => void {
    this.hooks.add(hook);
    return () => { this.hooks.delete(hook); };
  }

  /** Hooks run after the camera update, right before rendering (for screen-space projection). */
  onBeforeRender(hook: FrameHook): () => void {
    this.renderHooks.add(hook);
    return () => { this.renderHooks.delete(hook); };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number): void => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
      // `last` is refreshed even on a skipped frame, so `dt` never accumulates across an idle stretch.
      this.last = now;
      if (this.contextLost) return; // keep the pending request for the restore
      if (!this.scheduler.take()) return;
      this.step(dt);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private readonly onContextLost = (e: Event): void => {
    // Without preventDefault the browser never fires `webglcontextrestored`.
    e.preventDefault();
    this.contextLost = true;
  };

  private readonly onContextRestored = (): void => {
    this.contextLost = false;
    // Full recovery (rebuilding GPU resources) is not implemented yet; at least draw again.
    this.requestRender();
  };

  /** Runs hooks, updates the camera / sun and renders one frame. */
  step(dt: number): void {
    this.time += dt;
    for (const h of [...this.hooks]) h(dt, this.time);
    this.cam.update(dt);
    const o = this.cam.orbit, d = this.sunDir;
    this.sun.position.set(o.x + d[0], d[1], o.z + d[2]);
    this.sun.target.position.set(o.x, 0, o.z);
    this.sun.target.updateMatrixWorld();
    for (const h of [...this.renderHooks]) h(dt, this.time);
    this.render();
    this.frames++;
  }

  render(): void {
    const r = this.renderer, camera = this.cam.camera;
    r.clear();
    camera.layers.set(LAYER_DEFAULT);
    r.render(this.scene, camera);
    if (this.silhouette.enabled && this.hasSilhouettes) {
      r.clearDepth();
      camera.layers.set(LAYER_OCCLUDER);
      this.scene.overrideMaterial = this.depthOnly;
      r.render(this.scene, camera);
      this.scene.overrideMaterial = null;
      camera.layers.set(LAYER_SILHOUETTE);
      r.render(this.scene, camera);
    }
    camera.layers.set(LAYER_DEFAULT);
  }

  dispose(): void {
    this.stop();
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.hooks.clear();
    this.renderHooks.clear();
    this.depthOnly.dispose();
    this.renderer.dispose();
  }
}
