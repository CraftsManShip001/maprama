/**
 * Visual themes: preset data shapes, the public {@link ThemeSpec}, and
 * {@link resolveTheme} which turns a spec into concrete render settings.
 *
 * Colors inside preset data are 24-bit RGB numbers (e.g. `0x4A7896`) except
 * `palette` (CSS hex strings) and CSS gradient strings in time-of-day data.
 *
 * @module
 */

import {
  anyOf,
  array,
  boolean,
  hexColorNumber,
  nonNegativeNumber,
  number,
  object,
  oneOf,
  positiveNumber,
  run,
  string,
  tuple,
  type Check,
  type ValidationResult,
} from './internal/validate.js';
import { CINE, PRESET_DEFAULTS, PRESETS, TIMES } from './presets/index.js';

/** Built-in preset names. */
export const PRESET_NAMES = ['realistic', 'toy', 'minimal', 'modern', 'urban', 'soft'] as const;
/** Built-in theme preset name. */
export type PresetName = (typeof PRESET_NAMES)[number];

/** Times of day. */
export const TIMES_OF_DAY = ['day', 'golden', 'dusk', 'night'] as const;
/** Time of day (lighting, fog and sky grading). */
export type TimeOfDay = (typeof TIMES_OF_DAY)[number];

/** Material shading models. */
export const SHADING_MODELS = ['standard', 'toon'] as const;
/** Material shading model: physically based `standard` or cel-shaded `toon`. */
export type ShadingModel = (typeof SHADING_MODELS)[number];

/** Facade texture sets. */
export const FACADE_SETS = ['real', 'toy', 'none', 'modern', 'urban', 'soft'] as const;
/** Facade texture set used for building walls. */
export type FacadeSet = (typeof FACADE_SETS)[number];

/** Glass styles for the central landmark. */
export const LANDMARK_GLASS_STYLES = ['real', 'modern', 'urban'] as const;
/** Glass style for the central landmark. */
export type LandmarkGlass = (typeof LANDMARK_GLASS_STYLES)[number];

/** Building massing modes. */
export const MASSING_MODES = ['box', 'varied'] as const;
/** Building massing: plain extruded `box`, or `varied` (setbacks, podiums). */
export type Massing = (typeof MASSING_MODES)[number];

/** Zoom-out behaviours. */
export const ZOOM_OUT_BEHAVIORS = ['none', 'mapColors', 'keepGameView'] as const;
/**
 * What happens when the camera zooms far out: `none` (no change), `mapColors`
 * (switch to flat map-style colors), `keepGameView` (keep the 3D game look).
 */
export type ZoomOutBehavior = (typeof ZOOM_OUT_BEHAVIORS)[number];

/** Colors of the central landmark (24-bit RGB numbers). */
export interface LandmarkColors {
  base: number;
  a: number;
  b: number;
  cone: number;
  /** Glass material style; absent means no glass. */
  glass?: LandmarkGlass;
}

/** Data for one theme preset (one entry of the prototype's `PRESETS`). */
export interface ThemePreset {
  shading: ShadingModel;
  /** Use procedural textures on ground and roads. */
  textured: boolean;
  /** Facade texture set. */
  facade: FacadeSet;
  /** Apply filmic tone mapping. */
  toneMapped: boolean;
  /** Render street life (trees, lamps and similar ambient props). */
  streetLife: boolean;
  /** Render building edge lines. */
  edgeLines: boolean;
  /** Force flat roofs. */
  flatRoofs: boolean;
  /** Multiplier on building heights (1 when absent). */
  heightScale?: number;
  /** Opacity of the sky haze overlay, 0..1. */
  hazeOpacity: number;
  /** Strength of the color grade overlay, 0..1. */
  grade: number;
  /** Building wall palette as CSS hex strings. */
  palette: string[];
  ground: number;
  road: number;
  pad: number;
  plaza: number;
  park: number;
  water: number;
  /** Rim / outline color. */
  rim: number;
  trunk: number;
  leafA: number;
  leafB: number;
  centerLine: number;
  crosswalkColor: number;
  landmark: LandmarkColors;
  /** Multiplier on hemisphere light intensity. */
  hemiMul: number;
  /** Multiplier on sun light intensity. */
  sunMul: number;
}

/** Lighting and atmosphere for one time of day (one entry of the prototype's `TIMES`). */
export interface TimeOfDayPreset {
  /** Fog color. */
  fog: number;
  /** Fog start distance in world units. */
  fogNear: number;
  /** Fog end distance in world units. */
  fogFar: number;
  /** Sun light color. */
  sun: number;
  /** Sun light intensity. */
  sunI: number;
  /** Hemisphere light sky color. */
  hemiSky: number;
  /** Hemisphere light ground color. */
  hemiGround: number;
  /** Hemisphere light intensity. */
  hemiI: number;
  /** Sun direction vector `[x, y, z]`. */
  dir: [number, number, number];
  /** Intensity of window / street lights, 0 = off. */
  lights: number;
  /** Tone-mapping exposure. */
  exposure: number;
  /** Render god rays. */
  rays?: boolean;
  /** CSS gradient painted as sky haze. */
  haze: string;
  /** CSS gradient painted as vignette. */
  vignette: string;
  /** CSS gradient color grade (present in cinematic overrides). */
  grade?: string;
}

/** Per-preset default toggles (one entry of the prototype's `PRESET_DEFAULTS`). */
export interface PresetDefaults {
  facade: boolean;
  outline: boolean;
  massing: Massing;
  /** Road lane markings. */
  lanes: boolean;
  crosswalks: boolean;
  /** Street props (lamps, signs, hydrants). */
  props: boolean;
  /** Parked cars, benches and bus stops. */
  parked: boolean;
  /** Ambient traffic. */
  traffic: boolean;
  /** Cinematic grading; {@link BASE_THEME_DEFAULTS} applies when absent. */
  cine?: boolean;
  /** Facade details; {@link BASE_THEME_DEFAULTS} applies when absent. */
  details?: boolean;
}

/** Public, declarative theme description. Every field is optional. */
export interface ThemeSpec {
  /** Built-in preset name or a full custom preset object. Default `'realistic'`. */
  base?: PresetName | ThemePreset;
  /** Default `'day'`. */
  timeOfDay?: TimeOfDay;
  /** Cinematic color grading. */
  cinematic?: boolean;
  /** Real-time shadows. */
  shadows?: boolean;
  buildings?: {
    /** Facade textures. */
    facade?: boolean;
    /** Outline (toon-style edge) rendering. */
    outline?: boolean;
    massing?: Massing;
    /** Facade details (balconies, AC units, signage). */
    details?: boolean;
    /** Height multiplier; replaces the preset's `heightScale` when set. */
    heightScale?: number;
  };
  roads?: {
    laneMarkings?: boolean;
    crosswalks?: boolean;
  };
  street?: {
    /** Street props (lamps, signs, hydrants). */
    props?: boolean;
    /** Parked cars, benches and bus stops. */
    parked?: boolean;
    /** Ambient traffic. */
    traffic?: boolean;
  };
  zoomOut?: ZoomOutBehavior;
}

/** Fully resolved theme: every option concrete. Produced by {@link resolveTheme}. */
export interface ResolvedTheme {
  /** Preset name, or `null` when `base` was a custom preset object. */
  presetName: PresetName | null;
  /** Preset data (shared, frozen for built-ins; do not mutate). */
  preset: ThemePreset;
  timeOfDay: TimeOfDay;
  /** Time-of-day lighting; `CINE[timeOfDay]` is merged over `TIMES[timeOfDay]` when cinematic. */
  time: TimeOfDayPreset;
  cinematic: boolean;
  shadows: boolean;
  buildings: {
    facade: boolean;
    outline: boolean;
    massing: Massing;
    details: boolean;
    heightScale: number;
  };
  roads: {
    laneMarkings: boolean;
    crosswalks: boolean;
  };
  street: {
    props: boolean;
    parked: boolean;
    traffic: boolean;
  };
  zoomOut: ZoomOutBehavior;
}

/**
 * Global fallbacks used when neither the spec nor the preset's defaults set a
 * value (mirrors the prototype's initial `style` object).
 */
export const BASE_THEME_DEFAULTS = Object.freeze({
  cinematic: false,
  shadows: true,
  details: false,
  zoomOut: 'none' as ZoomOutBehavior,
  timeOfDay: 'day' as TimeOfDay,
});

function isPresetName(value: unknown): value is PresetName {
  return typeof value === 'string' && (PRESET_NAMES as readonly string[]).includes(value);
}

/**
 * Resolves a {@link ThemeSpec} into concrete settings.
 *
 * Precedence (highest first): spec field → `PRESET_DEFAULTS[base]` →
 * {@link BASE_THEME_DEFAULTS}. A custom preset object uses the `realistic`
 * defaults. An unknown preset name falls back to `realistic`. Never throws for
 * well-typed input.
 */
export function resolveTheme(spec: ThemeSpec = {}): ResolvedTheme {
  const base = spec.base ?? 'realistic';
  let presetName: PresetName | null;
  let preset: ThemePreset;
  if (typeof base === 'string') {
    presetName = isPresetName(base) ? base : 'realistic';
    preset = PRESETS[presetName];
  } else {
    presetName = null;
    preset = base;
  }
  const defaults = PRESET_DEFAULTS[presetName ?? 'realistic'];
  const timeOfDay: TimeOfDay =
    spec.timeOfDay && (TIMES_OF_DAY as readonly string[]).includes(spec.timeOfDay)
      ? spec.timeOfDay
      : BASE_THEME_DEFAULTS.timeOfDay;
  const cinematic = spec.cinematic ?? defaults.cine ?? BASE_THEME_DEFAULTS.cinematic;
  const time: TimeOfDayPreset = cinematic
    ? { ...TIMES[timeOfDay], ...CINE[timeOfDay] }
    : { ...TIMES[timeOfDay] };

  return {
    presetName,
    preset,
    timeOfDay,
    time,
    cinematic,
    shadows: spec.shadows ?? BASE_THEME_DEFAULTS.shadows,
    buildings: {
      facade: spec.buildings?.facade ?? defaults.facade,
      outline: spec.buildings?.outline ?? defaults.outline,
      massing: spec.buildings?.massing ?? defaults.massing,
      details: spec.buildings?.details ?? defaults.details ?? BASE_THEME_DEFAULTS.details,
      heightScale: spec.buildings?.heightScale ?? preset.heightScale ?? 1,
    },
    roads: {
      laneMarkings: spec.roads?.laneMarkings ?? defaults.lanes,
      crosswalks: spec.roads?.crosswalks ?? defaults.crosswalks,
    },
    street: {
      props: spec.street?.props ?? defaults.props,
      parked: spec.street?.parked ?? defaults.parked,
      traffic: spec.street?.traffic ?? defaults.traffic,
    },
    zoomOut: spec.zoomOut ?? BASE_THEME_DEFAULTS.zoomOut,
  };
}

/** @internal Runtime check for {@link ThemePreset}. */
export const checkThemePreset: Check = object(
  {
    shading: oneOf(SHADING_MODELS),
    textured: boolean,
    facade: oneOf(FACADE_SETS),
    toneMapped: boolean,
    streetLife: boolean,
    edgeLines: boolean,
    flatRoofs: boolean,
    hazeOpacity: number,
    grade: number,
    palette: array(string, { min: 1 }),
    ground: hexColorNumber,
    road: hexColorNumber,
    pad: hexColorNumber,
    plaza: hexColorNumber,
    park: hexColorNumber,
    water: hexColorNumber,
    rim: hexColorNumber,
    trunk: hexColorNumber,
    leafA: hexColorNumber,
    leafB: hexColorNumber,
    centerLine: hexColorNumber,
    crosswalkColor: hexColorNumber,
    landmark: object(
      { base: hexColorNumber, a: hexColorNumber, b: hexColorNumber, cone: hexColorNumber },
      { glass: oneOf(LANDMARK_GLASS_STYLES) },
    ),
    hemiMul: number,
    sunMul: number,
  },
  { heightScale: positiveNumber },
);

/** @internal Runtime check for {@link TimeOfDayPreset}. */
export const checkTimeOfDayPreset: Check = object(
  {
    fog: hexColorNumber,
    fogNear: number,
    fogFar: number,
    sun: hexColorNumber,
    sunI: nonNegativeNumber,
    hemiSky: hexColorNumber,
    hemiGround: hexColorNumber,
    hemiI: nonNegativeNumber,
    dir: tuple(number, number, number),
    lights: nonNegativeNumber,
    exposure: nonNegativeNumber,
    haze: string,
    vignette: string,
  },
  { rays: boolean, grade: string },
);

/** @internal Runtime check for {@link ThemeSpec}. */
export const checkThemeSpec: Check = object(
  {},
  {
    base: anyOf(oneOf(PRESET_NAMES), checkThemePreset),
    timeOfDay: oneOf(TIMES_OF_DAY),
    cinematic: boolean,
    shadows: boolean,
    buildings: object(
      {},
      { facade: boolean, outline: boolean, massing: oneOf(MASSING_MODES), details: boolean, heightScale: positiveNumber },
    ),
    roads: object({}, { laneMarkings: boolean, crosswalks: boolean }),
    street: object({}, { props: boolean, parked: boolean, traffic: boolean }),
    zoomOut: oneOf(ZOOM_OUT_BEHAVIORS),
  },
);

/** Validates an unknown value as a {@link ThemeSpec}. Never throws. */
export function validateThemeSpec(value: unknown): ValidationResult {
  return run(checkThemeSpec, value);
}

/** Validates an unknown value as a full {@link ThemePreset} (e.g. a loaded theme JSON). Never throws. */
export function validateThemePreset(value: unknown): ValidationResult {
  return run(checkThemePreset, value);
}
