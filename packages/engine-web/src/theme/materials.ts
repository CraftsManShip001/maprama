/**
 * Material factory with preset shading (standard PBR or toon), window-light
 * emissive handling per time of day, per-theme caches and material
 * conversion on theme change (ported from the prototype's `makeMat` / `M` /
 * `tmat` / `convertMaterials`).
 *
 * Colors are sRGB hex numbers; three r186 converts them to linear
 * automatically (no manual `convertSRGBToLinear`).
 *
 * @module
 */

import {
  BackSide,
  Color,
  DataTexture,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MeshToonMaterial,
  NearestFilter,
  RGBAFormat,
  type MeshBasicMaterialParameters,
  type Object3D,
  type Side,
  type Texture,
} from 'three';
import type { ShadingModel, ThemePreset } from '@diorama/protocol';
import { INK } from '@diorama/protocol';

/** Extra material options (prototype `extra`). */
export interface MatExtra {
  map?: Texture | null;
  alphaTest?: number;
  /** Use vertex colors (ignored for toon shading, like the prototype). */
  vertexColors?: boolean;
  /** Lit-window emissive map; only applied when the time of day has lights. */
  emissiveMap?: Texture | null;
  emissiveScale?: number;
  /** Constant emissive intensity. */
  glow?: number;
  glowColor?: number;
  glowMap?: Texture;
  roughness?: number;
  metalness?: number;
  side?: Side;
  transparent?: boolean;
  opacity?: number;
}

interface MatSpec {
  color: number;
  extra: MatExtra;
}

export const ACCENT = 0x2f5bea;

/** Color keys of a {@link ThemePreset} usable with {@link MaterialFactory.themed}. */
export type ThemeColorKey = Exclude<
  {
    [K in keyof ThemePreset]-?: ThemePreset[K] extends number ? K : never;
  }[keyof ThemePreset],
  'heightScale' | 'hazeOpacity' | 'grade' | 'hemiMul' | 'sunMul' | undefined
>;

export class MaterialFactory {
  shading: ShadingModel = 'standard';
  /** Window-light intensity of the current time of day. */
  lights = 0;
  preset: ThemePreset | null = null;
  /** Toon gradient (data texture, no color space). */
  readonly gradient: DataTexture;
  /** Outline ink (toy preset). */
  readonly ink: MeshBasicMaterial;
  /** Depth-only material for the silhouette occluder pass. */
  readonly depthOnly: MeshBasicMaterial;
  private cache = new Map<string, Material>();
  private generation = new Set<Material>();

  constructor() {
    this.gradient = new DataTexture(new Uint8Array([120, 120, 120, 255, 196, 196, 196, 255, 255, 255, 255, 255]), 3, 1, RGBAFormat);
    this.gradient.minFilter = this.gradient.magFilter = NearestFilter;
    this.gradient.generateMipmaps = false;
    this.gradient.needsUpdate = true;
    this.ink = new MeshBasicMaterial({ color: INK, side: BackSide });
    this.depthOnly = new MeshBasicMaterial({ colorWrite: false });
  }

  /** Creates a lit material with the current shading (prototype `M`). */
  make(color: number, extra: MatExtra = {}): MeshStandardMaterial | MeshToonMaterial {
    const m = this.build(color, extra);
    m.userData.spec = { color, extra } satisfies MatSpec;
    this.generation.add(m);
    return m;
  }

  /** Creates an unlit material (tracked for disposal with the current generation). */
  basic(params: MeshBasicMaterialParameters): MeshBasicMaterial {
    const m = new MeshBasicMaterial(params);
    this.generation.add(m);
    return m;
  }

  /** Returns a cached material for this theme generation. */
  cached<T extends Material>(key: string, make: () => T): T {
    let m = this.cache.get(key) as T | undefined;
    if (!m) {
      m = make();
      this.cache.set(key, m);
    }
    return m;
  }

  /** Cached material colored by a theme preset key (prototype `tmat`). */
  themed(key: ThemeColorKey, extra?: MatExtra): Material {
    const k = 'theme:' + key + (extra ? JSON.stringify(Object.keys(extra)) : '');
    return this.cached(k, () => this.make(this.preset ? (this.preset[key] as number) : 0xffffff, extra));
  }

  /**
   * Switches shading / lights for a new theme and starts a new material
   * generation. Returns a function that disposes the previous generation;
   * call it after the scene has been rebuilt / converted.
   */
  beginTheme(preset: ThemePreset, lights: number): () => void {
    this.preset = preset;
    this.shading = preset.shading;
    this.lights = lights;
    this.cache.clear();
    const old = this.generation;
    this.generation = new Set();
    return () => {
      for (const m of old) if (!this.generation.has(m)) m.dispose();
    };
  }

  /** Rebuilds one material created by {@link make} for the current shading; others are returned as is. */
  convert(m: Material, memo = new Map<Material, Material>()): Material {
    const spec = m.userData?.spec as MatSpec | undefined;
    if (!spec) return m;
    let n = memo.get(m);
    if (!n) {
      n = this.make(spec.color, spec.extra);
      memo.set(m, n);
    }
    return n;
  }

  /** Converts every mesh material in a subtree (for objects that are not rebuilt on theme change). */
  convertTree(root: Object3D, memo = new Map<Material, Material>()): void {
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => this.convert(m, memo)) : this.convert(mesh.material, memo);
    });
  }

  dispose(): void {
    for (const m of this.generation) m.dispose();
    this.generation.clear();
    this.cache.clear();
    this.gradient.dispose();
    this.ink.dispose();
    this.depthOnly.dispose();
  }

  private build(color: number, extra: MatExtra): MeshStandardMaterial | MeshToonMaterial {
    const common: Record<string, unknown> = { color: new Color(color) };
    if (extra.map) common.map = extra.map;
    if (extra.alphaTest) common.alphaTest = extra.alphaTest;
    if (extra.side !== undefined) common.side = extra.side;
    if (extra.transparent) common.transparent = true;
    if (extra.opacity !== undefined) common.opacity = extra.opacity;
    if (extra.vertexColors && this.shading !== 'toon') common.vertexColors = true;
    if (extra.emissiveMap && this.lights > 0) {
      common.emissiveMap = extra.emissiveMap;
      common.emissive = new Color(0xffffff);
      common.emissiveIntensity = this.lights * (extra.emissiveScale || 1);
    } else if (extra.glow) {
      common.emissive = new Color(extra.glowColor ?? 0xffffff);
      common.emissiveIntensity = extra.glow;
      if (extra.glowMap) common.emissiveMap = extra.glowMap;
    }
    if (this.shading === 'toon') return new MeshToonMaterial({ ...common, gradientMap: this.gradient });
    return new MeshStandardMaterial({ ...common, roughness: extra.roughness ?? 0.9, metalness: extra.metalness || 0 });
  }
}
