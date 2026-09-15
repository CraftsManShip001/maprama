/**
 * Theme resolution → concrete render parameters. Pure (no three.js / DOM) so
 * it can be unit-tested; the renderer applies these values.
 *
 * @module
 */

import {
  resolveTheme,
  type FacadeSet,
  type Massing,
  type ResolvedTheme,
  type ShadingModel,
  type ThemePreset,
  type ThemeSpec,
  type TimeOfDayPreset,
  type ZoomOutBehavior,
} from '@maprama/protocol';

/**
 * three r186 uses physically based light units (the legacy mode of r128 is
 * gone). r128's legacy mode multiplied punctual/hemisphere irradiance by π,
 * so the prototype's intensities are scaled by π, then calibrated visually.
 */
export const LIGHT_SCALE = Math.PI;

/** Concrete values the renderer applies for a theme. */
export interface RenderParams {
  resolved: ResolvedTheme;
  preset: ThemePreset;
  time: TimeOfDayPreset;
  shading: ShadingModel;
  textured: boolean;
  facadeSet: FacadeSet;
  /** Facade textures enabled (theme toggle and a set other than `none`). */
  facadeOn: boolean;
  outline: boolean;
  massing: Massing;
  details: boolean;
  heightScale: number;
  flatRoofs: boolean;
  edgeLines: boolean;
  toneMapped: boolean;
  exposure: number;
  clearColor: number;
  fog: { color: number; near: number; far: number };
  hemi: { sky: number; ground: number; intensity: number };
  sun: { color: number; intensity: number; dir: [number, number, number] };
  shadows: boolean;
  /** Window / street light intensity (0 = off). */
  lights: number;
  overlays: {
    haze: string;
    vignette: string;
    hazeOpacity: number;
    /** CSS gradient or `null` when not cinematic. */
    grade: string | null;
    gradeOpacity: number;
    rays: boolean;
  };
  roads: { laneMarkings: boolean; crosswalks: boolean };
  street: { props: boolean; parked: boolean; traffic: boolean };
  zoomOut: ZoomOutBehavior;
  palette: string[];
}

/** Resolves a theme spec (see `resolveTheme`) into render parameters. */
export function renderParamsFor(spec: ThemeSpec = {}): RenderParams {
  const resolved = resolveTheme(spec);
  const { preset, time } = resolved;
  return {
    resolved,
    preset,
    time,
    shading: preset.shading,
    textured: preset.textured,
    facadeSet: preset.facade,
    facadeOn: resolved.buildings.facade && preset.facade !== 'none',
    outline: resolved.buildings.outline,
    massing: resolved.buildings.massing,
    details: resolved.buildings.details,
    heightScale: resolved.buildings.heightScale,
    flatRoofs: preset.flatRoofs,
    edgeLines: preset.edgeLines,
    toneMapped: preset.toneMapped,
    exposure: preset.toneMapped ? time.exposure : 1,
    clearColor: time.fog,
    fog: { color: time.fog, near: time.fogNear, far: time.fogFar },
    hemi: { sky: time.hemiSky, ground: time.hemiGround, intensity: time.hemiI * preset.hemiMul * LIGHT_SCALE },
    sun: { color: time.sun, intensity: time.sunI * preset.sunMul * LIGHT_SCALE, dir: [...time.dir] },
    shadows: resolved.shadows,
    lights: time.lights,
    overlays: {
      haze: time.haze,
      vignette: time.vignette,
      hazeOpacity: preset.hazeOpacity,
      grade: resolved.cinematic && time.grade ? time.grade : null,
      gradeOpacity: preset.grade,
      rays: !!time.rays,
    },
    roads: { ...resolved.roads },
    street: { ...resolved.street },
    zoomOut: resolved.zoomOut,
    palette: [...preset.palette],
  };
}
