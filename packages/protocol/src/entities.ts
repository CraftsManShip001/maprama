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

/** Built-in marker base shapes. */
export const MARKER_SHAPES = ['pin', 'dot'] as const;
/** Base shape a marker is drawn with; a custom icon is drawn inside it. */
export type MarkerShape = (typeof MARKER_SHAPES)[number];

/**
 * A custom marker icon drawn inside the base shape: a `data:image/svg+xml`,
 * `https:`, `file:` or bundled asset URI.
 */
export interface MarkerImage {
  uri: string;
}

/** What a marker shows: a built-in base shape, or a custom image on the base shape. */
export type MarkerIcon = MarkerShape | MarkerImage;

/** Which point of the marker sits on its coordinate. */
export const MARKER_ANCHORS = ['bottom', 'center', 'top'] as const;
/** Marker anchor; `bottom` (the default) puts the pin tip on the coordinate. */
export type MarkerAnchor = (typeof MARKER_ANCHORS)[number];

/** Named heights a marker can sit at above its coordinate. */
export const MARKER_ANCHOR_HEIGHTS = ['ground', 'roof'] as const;
/**
 * How high above its coordinate a marker sits: `ground` (the default — the
 * terrain), `roof` (the top of the building the coordinate falls in, the ground
 * when there is none), or a number of meters above the ground.
 *
 * `ground` stays the default because integrators already place pins with it;
 * on a tilted camera a ground pin inside a tall building is drawn *behind* the
 * building, which is what `roof` fixes.
 */
export type MarkerAnchorHeight = (typeof MARKER_ANCHOR_HEIGHTS)[number] | number;

/** Per-marker building snapping (see {@link MarkerSpec.snapToBuilding}). */
export interface MarkerSnapToBuilding {
  /** Search radius in meters. Default {@link DEFAULT_SNAP_TO_BUILDING_METERS}. */
  maxDistanceMeters?: number;
}

/**
 * Default search radius of `snapToBuilding` (the request and the marker option),
 * in meters.
 *
 * Measured on five Korean areas (Gangnam, Seongsu, Jeonju, Bundang, Gurye;
 * 171 POIs): 20 m recovers 65 % of the POIs that fall outside every footprint,
 * and only 3 of those 28 have a second candidate within 2 m of the winner.
 * Raising it to 40 m recovers 86 % but starts crossing arterial roads
 * (Gangnam-daero alone is ~50 m wide), which attaches a pin to the building on
 * the *other side of the street* — a worse error than a pin in open space.
 */
export const DEFAULT_SNAP_TO_BUILDING_METERS = 20;

/**
 * An app-owned map pin drawn by the engine at a fixed screen size.
 *
 * Markers live in layers (`setMarkerLayer`) and are matched by `id` across
 * updates: an engine must apply a changed `color` or selection without
 * reloading the icon or recreating the marker's view.
 */
export interface MarkerSpec {
  /** Stable id, unique within its layer. */
  id: string;
  coordinate: LngLat;
  /** Base shape, or a custom image on the base shape. Default `'pin'`. */
  icon?: MarkerIcon;
  /** Tint of the base shape as a CSS hex string (e.g. `'#2F5BEA'`). Engine accent when absent. */
  color?: string;
  /** Collision priority; higher wins. Default 0. */
  priority?: number;
  /** Never hidden by collision (placed before the others). Default false. */
  alwaysVisible?: boolean;
  /** Text a screen reader announces for this marker (e.g. `"Gyeongbokgung, Blue"`). */
  accessibilityLabel?: string;
  /**
   * How high the marker sits. Default `'ground'` — unchanged from the first
   * release, because apps already position pins against it.
   */
  anchorHeight?: MarkerAnchorHeight;
  /**
   * Move the marker onto the nearest building when `coordinate` falls outside
   * every footprint. `true` uses {@link DEFAULT_SNAP_TO_BUILDING_METERS}.
   * Default: off — the engine never moves a coordinate the app gave it unless
   * the app asks.
   *
   * Independent of {@link MarkerSpec.anchorHeight}, but they are usually set
   * together: snapping finds the building, `anchorHeight: 'roof'` then puts the
   * pin on top of it. `marker:press` keeps reporting the **original**
   * coordinate, so a press still maps back to the app's own record.
   */
  snapToBuilding?: boolean | MarkerSnapToBuilding;
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

/**
 * Vertical field of view of the map camera, in degrees. Every engine frames a
 * `CameraSpec.distance` with this frustum, so the ground span a distance shows
 * is the same in the web and the native engine.
 *
 * Use {@link visibleSpanMeters} instead of hard-coding it.
 */
export const CAMERA_FOV_DEG = 40;

/**
 * The ground span (meters, measured at the camera target, across the **height**
 * of the view) that a camera `distance` frames:
 * `2 · distance · tan(CAMERA_FOV_DEG / 2)` — about `0.728 · distance`.
 *
 * At a pitch above 0 the view is a trapezoid and reaches further towards the
 * horizon than half this span; this is the value the `distance` ⇄ `zoom`
 * conversion is defined on, and the right quantity for "how much of my city
 * fits on screen".
 */
export function visibleSpanMeters(distanceMeters: number): number {
  return 2 * distanceMeters * Math.tan((CAMERA_FOV_DEG * Math.PI) / 360);
}

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
  /**
   * Closest the camera may come to its target, in **meters**. Independent of
   * the world's `unitMeters`, and applied to every path that changes the
   * distance: `setCamera`, `zoom`, pinch, wheel, the zoom buttons, `follow`
   * and the zoom-out behaviour.
   *
   * Sticky: it stays in force until another camera spec changes it. Absent
   * keeps the current limit; the engine default is 14 world units
   * (112 m at the default 8 m per unit).
   *
   * An engine clamps the pair into the range it can render and reports a
   * non-fatal `error` with code `camera_limits_clamped` when it has to.
   */
  minDistanceMeters?: number;
  /**
   * Furthest the camera may go from its target, in **meters**. See
   * {@link CameraSpec.minDistanceMeters}; the engine default is 150 world
   * units (1,200 m at the default 8 m per unit).
   *
   * Widening this widens the fog, shadow and level-of-detail ranges with it,
   * so a wide view keeps the look it has at the default limit.
   */
  maxDistanceMeters?: number;
}

/**
 * Space along the edges of the map view that app chrome covers, in
 * density-independent pixels. Every side defaults to 0.
 *
 * The map keeps rendering across the whole view — only the *visible area*
 * (the view minus the inset) changes, and with it everything that means "where
 * the user is looking": the camera centre, `follow` centring, the engine
 * ornaments, label / marker placement, `overlay:positions` visibility and the
 * `bounds` / `radiusMeters` of `camera:idle`.
 *
 * @see {@link MapUiSpec.contentInset}
 */
export interface ContentInset {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

/** Map UI elements drawn by the engine. */
export interface MapUiSpec {
  /** Location puck with accuracy ring. */
  locationPuck?: boolean;
  scaleBar?: boolean;
  zoomButtons?: boolean;
  /** Data attribution text (required by data licenses when shipping real data). */
  attribution?: boolean;
  /**
   * Space app chrome (a bottom sheet, a top bar…) covers along the edges of the
   * map view, in dp. Unset sides are 0.
   *
   * The engine keeps drawing the whole view; the inset moves what the user is
   * meant to see and touch into the remaining rectangle:
   *
   * - a `setCamera` `center` lands at the centre of the **visible** area, and
   *   the camera state the engine reports (`camera:change`, `camera:idle`,
   *   `fitBounds`) is that same point;
   * - a followed character stays centred in the visible area;
   * - the ornaments (`scaleBar`, `zoomButtons`, `attribution`) move inside it,
   *   so a sheet can never cover the attribution while `attribution` is on;
   * - labels and markers are placed and clamped inside it;
   * - `ScreenPoint.visible` (`project`, `overlay:positions`) means "inside the
   *   visible area";
   * - `camera:idle` reports the ground `bounds` and `radiusMeters` of the
   *   visible area.
   *
   * It does **not** change the screen coordinate frame: `project` and
   * `unproject` keep working in full-view pixels with the origin at the top
   * left of the whole map view (see {@link ScreenPoint}).
   */
  contentInset?: ContentInset;
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

const markerIcon: Check = anyOf(oneOf(MARKER_SHAPES), object({ uri: nonEmptyString }));
const markerAnchorHeight: Check = anyOf(oneOf(MARKER_ANCHOR_HEIGHTS), number);
const markerSnapToBuilding: Check = anyOf(boolean, object({}, { maxDistanceMeters: nonNegativeNumber }));

/** @internal */
export const checkMarkerSpec: Check = object(
  { id: nonEmptyString, coordinate: checkLngLat },
  {
    icon: markerIcon,
    color: cssHexColor,
    priority: number,
    alwaysVisible: boolean,
    accessibilityLabel: string,
    anchorHeight: markerAnchorHeight,
    snapToBuilding: markerSnapToBuilding,
  },
);

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
    minDistanceMeters: positiveNumber,
    maxDistanceMeters: positiveNumber,
  },
);

/** @internal */
export const checkContentInset: Check = object(
  {},
  { top: nonNegativeNumber, right: nonNegativeNumber, bottom: nonNegativeNumber, left: nonNegativeNumber },
);

/** @internal */
export const checkMapUiSpec: Check = object(
  {},
  {
    locationPuck: boolean,
    scaleBar: boolean,
    zoomButtons: boolean,
    attribution: boolean,
    contentInset: checkContentInset,
  },
);
