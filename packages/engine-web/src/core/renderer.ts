/**
 * Renderer + scene + lights + render loop, including the silhouette pass
 * service (layer 0 normal render, layer 1 depth-only occluders, layer 2
 * silhouettes drawn with `GreaterDepth` behind occluders).
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
  private readonly depthOnly = new MeshBasicMaterial({ colorWrite: false });

  constructor(canvas: HTMLCanvasElement, private readonly cam: CameraController) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
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
  }

  /** Sets the drawing buffer size (CSS pixels). */
  resize(width: number, height: number): void {
    this.renderer.setSize(Math.max(1, width), Math.max(1, height), false);
    this.cam.setViewport(width, height);
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
      this.last = now;
      this.step(dt);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

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
    this.hooks.clear();
    this.renderHooks.clear();
    this.depthOnly.dispose();
    this.renderer.dispose();
  }
}
