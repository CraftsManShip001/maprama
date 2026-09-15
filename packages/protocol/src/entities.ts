/**
 * Things that live on the map: characters, drops, geofences, building styles,
 * location fixes, camera and map UI.
 *
 * @module
 */

import { checkLngLat, type LngLat } from './geo.js';
import {
  anyOf,
  array,
  boolean,
  json,
  nonEmptyString,
  nonNegativeNumber,
  nullable,
  number,
  object,
  oneOf,
  positiveNumber,
  range,
  string,
  type Check,
} from './internal/validate.js';
import { MASSING_MODES, type Massing } from './theme.js';

/** Any JSON-serialisable value. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** A 3D model reference: a glTF 2.0 / GLB file URI (http(s), file or bundled asset URI). */
export interface ModelSource {
  uri: string;
}

/** Conventional animation clip names. */
export const ANIMATION_NAMES = ['idle', 'walk', 'run', 'ride', 'wave'] as const;
/** Conventional character animation name. */
export type AnimationName = (typeof ANIMATION_NAMES)[number];

/**
 * A character (player avatar or other actor).
 *
 * `upsertCharacters` merges a spec into the engine's copy of the character: an
 * absent field keeps its current value, and `null` clears an optional field
 * back to its default. `id` and `position` cannot be `null`.
 */
export interface CharacterSpec {
  /** Stable id, unique across characters. */
  id: string;
  /**
   * glTF/GLB model. Engine default avatar when absent. Upserts merge into the
   * existing character, so send `null` to drop a model and show the default avatar again.
   */
  model?: ModelSource | null;
  /** Display name (shown in the name tag). `null` clears it; the tag then shows the id. */
  name?: string | null;
  /**
   * Tint / accent color as a CSS hex string (e.g. `'#2F5BEA'`), used by the default avatar and name tag.
   * `null` restores the engine's default player / NPC color.
   */
  color?: string | null;
  /** Initial or teleport position. */
  position?: LngLat;
  /**
   * `location`: driven by the active location source; `none`: moved only by commands.
   * `null` restores the default (not driven by the location source).
   */
  follow?: 'location' | 'none' | null;
  /** The local player (at most one). Default collector for drops. `null` restores the default (`false`). */
  isPlayer?: boolean | null;
  /** Uniform model scale multiplier. Default 1; `null` restores it. */
  scale?: number | null;
  /**
   * Maps conventional animation names to clip names in the model. Clips named
   * exactly `idle|walk|run|ride|wave` are used when not mapped. `null` drops the
   * mapping and returns to that automatic matching.
   */
  animations?: Partial<Record<AnimationName, string>> | null;
  /** Show a floating name tag. `null` restores the default (`false`, no tag). */
  showNameTag?: boolean | null;
}

/** Travel modes. */
export const TRAVEL_MODES = ['walk', 'bike', 'car', 'plane', 'subway'] as const;
/**
 * Travel mode. A travel request carries an ordered list of modes, e.g.
 * `['walk', 'car', 'walk']`; `['subway']` expands to walk → subway → walk
 * between the nearest stations.
 */
export type TravelMode = (typeof TRAVEL_MODES)[number];

/** Drop types. */
export const DROP_TYPES = ['coin', 'cd', 'vinyl', 'note', 'model'] as const;
/** Drop visual type; `model` uses {@link DropSpec.model}. */
export type DropType = (typeof DROP_TYPES)[number];

/** Drop rarities. */
export const RARITIES = ['common', 'rare', 'legendary'] as const;
/** Drop rarity (affects visual effects). */
export type Rarity = (typeof RARITIES)[number];

/** A collectible item placed on the map. */
export interface DropSpec {
  /** Stable id, unique within its layer. */
  id: string;
  type: DropType;
  /** Custom model; required when `type` is `'model'`. */
  model?: ModelSource;
  coordinate: LngLat;
  /** Default `'common'`. */
  rarity?: Rarity;
  /** Numeric value shown / reported (e.g. coin amount). */
  value?: number;
  /** Arbitrary host data, echoed back to the host on collection. */
  payload?: JsonValue;
}

/** A circular geofence. */
export interface GeofenceSpec {
  id: string;
  center: LngLat;
  radiusMeters: number;
}

/** Roof shapes for building style overrides. */
export const ROOF_SHAPES = ['flat', 'gable', 'dome'] as const;
/** Roof shape. */
export type RoofShape = (typeof ROOF_SHAPES)[number];

/** Building decorations. */
export const BUILDING_DECORATIONS = ['sign', 'antenna', 'trees'] as const;
/** Building decoration. */
export type BuildingDecoration = (typeof BUILDING_DECORATIONS)[number];

/** Per-building style override. Unset fields keep the theme's look. */
export interface BuildingStyle {
  /** Color tint as a CSS hex string (e.g. `'#FF8800'`). */
  color?: string;
  roof?: RoofShape;
  /** Facade textures on/off for this building. */
  facade?: boolean;
  decorations?: BuildingDecoration[];
  massing?: Massing;
  /** Replace the extruded building with a custom glTF/GLB model. */
  replaceModel?: ModelSource;
  /** Free-form host state (e.g. `'captured'`), usable by engine-side style rules. */
  state?: string;
}

/** A location fix injected by the host (`external` source) or produced by the device. */
export interface LocationFix {
  lng: number;
  lat: number;
  /** Horizontal accuracy radius in meters. */
  accuracyMeters?: number;
  /** Heading in degrees clockwise from north. */
  headingDeg?: number;
  /** Ground speed in meters per second. */
  speedMps?: number;
  /** Fix time in milliseconds since the Unix epoch. */
  timestamp: number;
}

/** Location source kinds. */
export const LOCATION_SOURCE_KINDS = ['device', 'external', 'simulated'] as const;
/**
 * Where the player position comes from: `device` (GPS with smoothing and road
 * matching), `external` (host pushes fixes via `pushLocation`), `simulated`
 * (demo loop).
 */
export type LocationSourceKind = (typeof LOCATION_SOURCE_KINDS)[number];

/** Camera state or target. All fields optional; unset fields keep their current value. */
export interface CameraSpec {
  /** Look-at target on the ground. */
  center?: LngLat;
  /** Distance from the target to the camera in meters. Takes precedence over `zoom`. */
  distance?: number;
  /** Web-map style zoom level, an alternative to `distance`. */
  zoom?: number;
  /** Tilt in degrees: 0 = looking straight down, larger = towards the horizon. */
  pitch?: number;
  /** Rotation in degrees clockwise from north. */
  bearing?: number;
  /** Character id to follow, or `null` to stop following. */
  follow?: string | null;
  /** Animate the transition (`true` = engine default duration). */
  animate?: boolean | { durationMs: number };
}

/** Map UI elements drawn by the engine. */
export interface MapUiSpec {
  /** Location puck with accuracy ring. */
  locationPuck?: boolean;
  scaleBar?: boolean;
  zoomButtons?: boolean;
  /** Data attribution text (required by data licenses when shipping real data). */
  attribution?: boolean;
}

/** @internal */
export const checkModelSource: Check = object({ uri: nonEmptyString });

/** CSS hex color `#RGB`, `#RRGGBB` or `#RRGGBBAA`. */
const cssHexColor: Check = (v, p) =>
  typeof v === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)
    ? null
    : `${p}: expected CSS hex color string like "#RRGGBB"`;

const animationMap: Check = object(
  {},
  Object.fromEntries(ANIMATION_NAMES.map((name) => [name, string])) as Record<string, Check>,
);

/** @internal */
export const checkCharacterSpec: Check = object(
  { id: nonEmptyString },
  {
    model: nullable(checkModelSource),
    name: nullable(string),
    color: nullable(cssHexColor),
    position: checkLngLat,
    follow: nullable(oneOf(['location', 'none'])),
    isPlayer: nullable(boolean),
    scale: nullable(positiveNumber),
    animations: nullable(animationMap),
    showNameTag: nullable(boolean),
  },
);

const baseDrop: Check = object(
  { id: nonEmptyString, type: oneOf(DROP_TYPES), coordinate: checkLngLat },
  { model: checkModelSource, rarity: oneOf(RARITIES), value: number, payload: json },
);

/** @internal */
export const checkDropSpec: Check = (v, p) => {
  const err = baseDrop(v, p);
  if (err) return err;
  const drop = v as { type: string; model?: unknown };
  return drop.type === 'model' && drop.model === undefined
    ? `${p}.model: required when type is "model"`
    : null;
};

/** @internal */
export const checkGeofenceSpec: Check = object({
  id: nonEmptyString,
  center: checkLngLat,
  radiusMeters: positiveNumber,
});

/** @internal */
export const checkBuildingStyle: Check = object(
  {},
  {
    color: cssHexColor,
    roof: oneOf(ROOF_SHAPES),
    facade: boolean,
    decorations: array(oneOf(BUILDING_DECORATIONS)),
    massing: oneOf(MASSING_MODES),
    replaceModel: checkModelSource,
    state: string,
  },
);

/** @internal */
export const checkLocationFix: Check = object(
  { lng: range(-180, 180), lat: range(-90, 90), timestamp: number },
  { accuracyMeters: nonNegativeNumber, headingDeg: number, speedMps: nonNegativeNumber },
);

/** @internal */
export const checkCameraSpec: Check = object(
  {},
  {
    center: checkLngLat,
    distance: positiveNumber,
    zoom: number,
    pitch: range(0, 90),
    bearing: number,
    follow: nullable(nonEmptyString),
    animate: anyOf(boolean, object({ durationMs: nonNegativeNumber })),
  },
);

/** @internal */
export const checkMapUiSpec: Check = object(
  {},
  { locationPuck: boolean, scaleBar: boolean, zoomButtons: boolean, attribution: boolean },
);
