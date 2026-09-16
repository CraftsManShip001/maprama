/**
 * The engine message protocol: commands (host → engine), events
 * (engine → host), the envelope, and a JSON codec with runtime validation.
 *
 * Messages are plain JSON-serialisable objects and make no assumption about
 * the transport (WebView `postMessage`, JSI, native bridge, WebSocket...).
 *
 * @module
 */

import { checkLngLat, checkLngLatBounds, type LngLat, type LngLatBounds } from './geo.js';
import {
  anyOf,
  array,
  boolean,
  discriminated,
  isRecord,
  json,
  nonEmptyString,
  nonNegativeInteger,
  nonNegativeNumber,
  number,
  object,
  oneOf,
  nullable,
  positiveNumber,
  range,
  record,
  run,
  string,
  type Check,
  type ValidationResult,
} from './internal/validate.js';
import {
  checkBuildingStyle,
  checkCameraSpec,
  checkCharacterSpec,
  checkDropSpec,
  checkGeofenceSpec,
  checkLocationFix,
  checkMapUiSpec,
  checkMarkerSpec,
  LOCATION_SOURCE_KINDS,
  MARKER_ANCHORS,
  TRAVEL_MODES,
  type BuildingStyle,
  type CameraSpec,
  type CharacterSpec,
  type DropSpec,
  type GeofenceSpec,
  type LocationFix,
  type LocationSourceKind,
  type MapUiSpec,
  type MarkerAnchor,
  type MarkerSpec,
  type TravelMode,
} from './entities.js';
import {
  checkLabelContent,
  checkLabelInfo,
  checkLabelsSpec,
  type LabelContent,
  type LabelInfo,
  type LabelsSpec,
} from './labels.js';
import { checkInfoCardSpec, type InfoCardSpec } from './info-card.js';
import { checkThemeSpec, type ThemeSpec } from './theme.js';
import { checkViewMode, type ViewMode } from './view.js';
import { checkWorldSource, type WorldSource } from './world.js';

/** Protocol version carried in every envelope's `v`. */
export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Commands (host → engine)
// ---------------------------------------------------------------------------

/** First command after the engine reports `ready`: loads the world and applies all settings. */
export interface InitCommand {
  type: 'init';
  world: WorldSource;
  theme: ThemeSpec;
  labels: LabelsSpec;
  ui: MapUiSpec;
  /** Initial camera; engine default framing when absent. */
  camera?: CameraSpec;
  locationSource: LocationSourceKind;
  /** Initial render view mode; `DEFAULT_VIEW_MODE` (`'2.5d'`) when absent. */
  view?: ViewMode;
}

/** Replaces the theme. */
export interface SetThemeCommand {
  type: 'setTheme';
  theme: ThemeSpec;
}

/** Replaces the label configuration. */
export interface SetLabelsCommand {
  type: 'setLabels';
  labels: LabelsSpec;
}

/** Sets host-supplied label content keyed by label id (see `labelsIndex`). Replaces previous entries. */
export interface SetLabelContentCommand {
  type: 'setLabelContent';
  entries: Record<string, LabelContent>;
}

/** Replaces the map UI configuration. */
export interface SetUiCommand {
  type: 'setUi';
  ui: MapUiSpec;
}

/** Moves the camera; unset fields keep their current value. */
export interface SetCameraCommand {
  type: 'setCamera';
  camera: CameraSpec;
}

/** Adds characters or updates existing ones by id. */
export interface UpsertCharactersCommand {
  type: 'upsertCharacters';
  characters: CharacterSpec[];
}

/** Removes characters by id. */
export interface RemoveCharactersCommand {
  type: 'removeCharacters';
  ids: string[];
}

/** Switches the location source. */
export interface SetLocationSourceCommand {
  type: 'setLocationSource';
  source: LocationSourceKind;
}

/** Injects a location fix (effective with the `external` source). */
export interface PushLocationCommand {
  type: 'pushLocation';
  fix: LocationFix;
}

/**
 * Starts travel for a character along an ordered list of modes. The engine
 * answers with `travel:start`, then `travel:arrive` or `travel:cancel`.
 *
 * The character moves at real-world speed per mode (walk 4.8, bike 15, car 30,
 * subway 60, plane 180 km/h) multiplied by `timeScale`.
 */
export interface TravelCommand {
  type: 'travel';
  /** Host-generated id correlating the travel events. */
  requestId: string;
  characterId: string;
  to: LngLat;
  /** Ordered modes, at least one. */
  modes: TravelMode[];
  /**
   * Playback speed factor (finite, > 0). `1` (the default when absent) is
   * real-world speed; `20` plays the trip twenty times faster. Distances are
   * unchanged; `travel:progress.etaSeconds` and `character:position.speedMps`
   * follow the scaled playback.
   */
  timeScale?: number;
}

/** Cancels the character's current travel. */
export interface CancelTravelCommand {
  type: 'cancelTravel';
  characterId: string;
}

/** Creates or replaces a drop layer. */
export interface SetDropLayerCommand {
  type: 'setDropLayer';
  layerId: string;
  drops: DropSpec[];
  /** A drop is collected when a collector comes within this many meters. */
  collectRadiusMeters: number;
  /** Characters that can collect; defaults to the player. */
  collectorIds?: string[];
}

/** Removes a drop layer. */
export interface RemoveDropLayerCommand {
  type: 'removeDropLayer';
  layerId: string;
}

/**
 * Creates or replaces a marker layer (app-owned map pins at a fixed screen
 * size), modelled on {@link SetDropLayerCommand}: the command carries the
 * layer's whole marker list and replaces the previous one.
 *
 * Markers are matched by `id`, so an update that only changes `color` or
 * `selectedId` must not make the engine reload an icon or recreate a view.
 */
export interface SetMarkerLayerCommand {
  type: 'setMarkerLayer';
  layerId: string;
  markers: MarkerSpec[];
  /**
   * Marker drawn in the selected state: scaled by `selectedScale` and never
   * hidden by collision. `null` (or absent) selects none.
   */
  selectedId?: string | null;
  /** Scale of the selected marker. Default 1.25. */
  selectedScale?: number;
  /** Marker height in density-independent pixels. Default 36. */
  size?: number;
  /** Which point of the marker sits on the coordinate. Default `'bottom'` (the pin tip). */
  anchor?: MarkerAnchor;
}

/** Removes a marker layer. */
export interface RemoveMarkerLayerCommand {
  type: 'removeMarkerLayer';
  layerId: string;
}

/**
 * Creates or replaces one holographic info card, keyed by `card.id`.
 *
 * One card per command (unlike `setMarkerLayer`, which carries a whole layer):
 * a card is a single rich object an app shows a handful of at a time, so
 * changing one must not resend the others.
 *
 * The engine only draws it. It does not open it on a press, and it does not
 * move the camera — the app decides when to send this, and whether to call
 * `focusOn` with it.
 */
export interface SetInfoCardCommand {
  type: 'setInfoCard';
  card: InfoCardSpec;
}

/** Removes one info card. Unknown ids are ignored. */
export interface RemoveInfoCardCommand {
  type: 'removeInfoCard';
  id: string;
}

/**
 * Switches the render view mode (see `ViewMode`).
 *
 * The transition is **animated by default** (`animate` absent is treated as
 * `true`): the buildings grow or sink and the pitch interpolates over
 * {@link VIEW_TRANSITION_MS}. `animate: false` applies the mode on the next
 * frame. Sending the mode the engine is already in is a no-op that still
 * answers with one `view:change`.
 *
 * @see `VIEW_TRANSITION_MS`, `DEFAULT_VIEW_MODE`
 */
export interface SetViewCommand {
  type: 'setView';
  view: ViewMode;
  /** `false` to switch instantly; `{ durationMs }` for a custom duration. Default `true`. */
  animate?: boolean | { durationMs: number };
}

/** Replaces all geofences. */
export interface SetGeofencesCommand {
  type: 'setGeofences';
  geofences: GeofenceSpec[];
}

/** Sets (or clears with `null`) a per-building style override. */
export interface SetBuildingStyleCommand {
  type: 'setBuildingStyle';
  buildingId: string;
  style: BuildingStyle | null;
}

/** An anchor for a host overlay view. */
export interface OverlayAnchor {
  id: string;
  coordinate: LngLat;
}

/** Replaces the overlay anchors whose screen positions the engine reports via `overlay:positions`. */
export interface SetOverlayAnchorsCommand {
  type: 'setOverlayAnchors';
  anchors: OverlayAnchor[];
}

/**
 * Continuous-value subscription topics. Topics added after the first release
 * are appended, so the index an engine derives from this list stays stable.
 */
export const SUBSCRIPTION_TOPICS = [
  'character:position',
  'camera:change',
  'travel:progress',
  'camera:idle',
] as const;
/** Topic of an opt-in, throttled continuous event stream. */
export type SubscriptionTopic = (typeof SUBSCRIPTION_TOPICS)[number];

/** Opts in to a throttled continuous event stream. */
export interface SubscribeCommand {
  type: 'subscribe';
  topic: SubscriptionTopic;
  /** Character id for `character:position` / `travel:progress`; all when absent. */
  id?: string;
  /**
   * Minimum interval between events in milliseconds. For `camera:idle` this is
   * a floor **between** idle events, not a delay before one: the event is
   * emitted once the camera has been still for the engine's idle delay
   * ({@link CAMERA_IDLE_DELAY_MS}) and then at most once per `throttleMs`.
   */
  throttleMs: number;
}

/** Cancels a subscription created with the same `topic` and `id`. */
export interface UnsubscribeCommand {
  type: 'unsubscribe';
  topic: SubscriptionTopic;
  id?: string;
}

/** A point in the map view in density-independent pixels, origin top-left. */
export interface ScreenPoint {
  x: number;
  y: number;
  /** False when off-screen or behind the camera. */
  visible: boolean;
}

/** Parameters per request method. */
export interface RequestParamsMap {
  /** Geographic coordinate → screen point. */
  project: { coordinate: LngLat };
  /** Screen point → ground coordinate. */
  unproject: { x: number; y: number };
  /** Nearest point on the road network. */
  snapToRoad: { coordinate: LngLat; maxDistanceMeters?: number };
  /** The building a coordinate falls in, or the nearest one within range. */
  snapToBuilding: { coordinate: LngLat; maxDistanceMeters?: number };
  /** Plans a route without moving anything. */
  route: { from: LngLat; to: LngLat; modes: TravelMode[] };
  /** Frames a geographic box and moves the camera there. */
  fitBounds: FitBoundsParams;
  /** Frames one point, and the space above it, and moves the camera there. */
  focusOn: FocusOnParams;
}

/** Padding kept free around a fitted box, in density-independent pixels. */
export type FitBoundsPadding = number | { top?: number; right?: number; bottom?: number; left?: number };

/** How `fitBounds` treats the current pitch and bearing. */
export const FIT_BOUNDS_ORIENTATIONS = ['auto', 'keep', 'reset'] as const;
/**
 * `keep`: frame the box at the current pitch / bearing. `reset`: look straight
 * down to north first (the tightest framing of a north-aligned box). `auto`
 * (the default): `keep`, but fall back to `reset` when the box does not fit at
 * the current orientation and resetting makes it fit.
 */
export type FitBoundsOrientation = (typeof FIT_BOUNDS_ORIENTATIONS)[number];

/** Parameters of the `fitBounds` request. */
export interface FitBoundsParams {
  bounds: LngLatBounds;
  /** Space kept free around the box, in dp. A single number applies to all four sides. Default 0. */
  padding?: FitBoundsPadding;
  /** Pitch to frame at, in degrees. Overrides `orientation` for the pitch. */
  pitch?: number;
  /** Bearing to frame at, in degrees. Overrides `orientation` for the bearing. */
  bearing?: number;
  /** Default `'auto'`. */
  orientation?: FitBoundsOrientation;
  /** Animate the move (`true` = engine default duration). Default: no animation. */
  animate?: boolean | { durationMs: number };
}

/** Result of `fitBounds`: the camera the engine moved to, and whether the box really fits. */
export interface FitBoundsResult {
  /** The camera the engine moved to (the end of the animation when one was requested). */
  camera: CameraState;
  /** True when the whole box, plus its padding, is inside the view at `camera`. */
  fitted: boolean;
  /** True when the distance limits (`minDistanceMeters` / `maxDistanceMeters`) decided the distance. */
  distanceLimited: boolean;
}

/**
 * Parameters of the `focusOn` request: put one point — and the column of air
 * above it, where an info card floats — in the visible area.
 *
 * It is the same kind of **request** as `fitBounds`, not an order: the distance
 * it needs is clamped into `minDistanceMeters` / `maxDistanceMeters`, and the
 * result says whether the target really fits and whether a limit decided the
 * distance. Exactly one of `coordinate` / `infoCardId` must be present.
 */
export interface FocusOnParams {
  /** The point to focus on. Mutually exclusive with `infoCardId`. */
  coordinate?: LngLat;
  /**
   * Focus on an info card sent with `setInfoCard`: its coordinate, its resolved
   * anchor (roof or ground) and its height are used, so the card ends up in
   * frame whatever it is attached to. Unknown ids fail with `unknown_info_card`.
   */
  infoCardId?: string;
  /**
   * Camera distance in meters. When absent the engine picks the distance at
   * which the target and `heightMeters` above it fit the visible area.
   */
  distance?: number;
  /** Pitch in degrees. Default: the current pitch. */
  pitch?: number;
  /** Bearing in degrees. Default: the current bearing (the map does not spin unasked). */
  bearing?: number;
  /**
   * Height above the target to keep in frame, in meters — the height an info
   * card floats at. Default: the card's own height with `infoCardId`, otherwise
   * {@link INFO_CARD_GROUND_HEIGHT_METERS}.
   */
  heightMeters?: number;
  /** Animate the move (`true` = engine default duration). Default: no animation. */
  animate?: boolean | { durationMs: number };
  /**
   * Keep the target inside the visible area (the view minus `ui.contentInset`)
   * rather than the whole view. Default true — a focused card must not end up
   * under a bottom sheet.
   */
  inset?: boolean;
}

/** Result of `focusOn`: the camera the engine moved to, and how well it worked. */
export interface FocusOnResult {
  /** The camera the engine moved to (the end of the animation when one was requested). */
  camera: CameraState;
  /** True when the target and the requested height are inside the visible area at `camera`. */
  fitted: boolean;
  /** True when the distance limits (`minDistanceMeters` / `maxDistanceMeters`) decided the distance. */
  distanceLimited: boolean;
}

/** Result of `snapToRoad`. */
export interface SnapToRoadResult {
  coordinate: LngLat;
  roadId: string;
  distanceMeters: number;
}

/**
 * Result of `snapToBuilding`: which building a coordinate belongs to, where on
 * it a pin should sit, and how far the answer moved the input.
 *
 * Built for the case where an app owns the coordinates (its own server's POI
 * table) and our world owns the buildings: the two were surveyed separately, so
 * a marker drawn at the app's coordinate often stands next to the building
 * rather than on it.
 */
export interface SnapToBuildingResult {
  /**
   * The snapped ground coordinate: the input itself when it was already inside
   * the footprint, otherwise a point just inside the building's outline.
   */
  coordinate: LngLat;
  buildingId: string;
  /** The building's height in meters, at the theme's current `heightScale`. */
  heightMeters: number;
  /** `coordinate` again — the point a roof-anchored pin stands over. */
  roofCoordinate: LngLat;
  /** How far `coordinate` is from the input, in meters. 0 when `inside`. */
  distanceMeters: number;
  /** True when the input coordinate was already inside the footprint. */
  inside: boolean;
}

/** One leg of a planned route. */
export interface RouteLeg {
  mode: TravelMode;
  meters: number;
  path: LngLat[];
}

/** Result of `route`. */
export interface RouteResult {
  legs: RouteLeg[];
  meters: number;
  /**
   * Real-world travel time in seconds at the per-mode speeds (independent of
   * any travel `timeScale`, unlike `travel:progress.etaSeconds`).
   */
  etaSeconds: number;
}

/** Results per request method. */
export interface RequestResultMap {
  project: ScreenPoint;
  /** `null` coordinate when the point does not hit the ground. */
  unproject: { coordinate: LngLat | null };
  /** `null` when no road is within range. */
  snapToRoad: SnapToRoadResult | null;
  /** `null` when no building contains the coordinate or lies within range. */
  snapToBuilding: SnapToBuildingResult | null;
  route: RouteResult;
  fitBounds: FitBoundsResult;
  focusOn: FocusOnResult;
}

/**
 * Request methods. Methods added after the first release are appended, so the
 * index an engine derives from this list stays stable.
 */
export const REQUEST_METHODS = ['project', 'unproject', 'snapToRoad', 'route', 'fitBounds', 'focusOn', 'snapToBuilding'] as const;
/** A request method name. */
export type RequestMethod = keyof RequestParamsMap;

/** A request for a specific method; answered by a `response` event with the same `requestId`. */
export interface RequestCommandOf<M extends RequestMethod> {
  type: 'request';
  requestId: string;
  method: M;
  params: RequestParamsMap[M];
}

/** A request/response call (discriminated on `method`). */
export type RequestCommand = { [M in RequestMethod]: RequestCommandOf<M> }[RequestMethod];

/** Any host → engine command (discriminated on `type`). */
export type EngineCommand =
  | InitCommand
  | SetThemeCommand
  | SetLabelsCommand
  | SetLabelContentCommand
  | SetUiCommand
  | SetCameraCommand
  | UpsertCharactersCommand
  | RemoveCharactersCommand
  | SetLocationSourceCommand
  | PushLocationCommand
  | TravelCommand
  | CancelTravelCommand
  | SetDropLayerCommand
  | RemoveDropLayerCommand
  | SetMarkerLayerCommand
  | RemoveMarkerLayerCommand
  | SetGeofencesCommand
  | SetBuildingStyleCommand
  | SetOverlayAnchorsCommand
  | SubscribeCommand
  | UnsubscribeCommand
  | RequestCommand
  | SetInfoCardCommand
  | RemoveInfoCardCommand
  | SetViewCommand;

/** Command `type` tag. */
export type EngineCommandType = EngineCommand['type'];

// ---------------------------------------------------------------------------
// Events (engine → host)
// ---------------------------------------------------------------------------

/** Engine implementation kinds. */
export const ENGINE_KINDS = ['web', 'native'] as const;
/** Engine implementation kind. */
export type EngineKind = (typeof ENGINE_KINDS)[number];

/** Identifies the engine implementation. */
export interface EngineInfo {
  name: string;
  version: string;
  kind: EngineKind;
}

/** Engine is loaded and accepts commands (the host sends `init` next). */
export interface ReadyEvent {
  type: 'ready';
  engine: EngineInfo;
}

/**
 * Well-known error codes. Engines may emit other codes.
 * - `invalid_message`: a command failed to decode/validate.
 * - `unsupported`: the engine does not implement a command or option.
 * - `world_load_failed`, `model_load_failed`: asset loading failed.
 * - `internal`: unexpected engine failure.
 */
export type EngineErrorCode =
  | 'invalid_message'
  | 'unsupported'
  | 'world_load_failed'
  | 'model_load_failed'
  | 'internal'
  | (string & {});

/** An engine error. */
export interface ErrorEvent {
  type: 'error';
  code: EngineErrorCode;
  message: string;
  /** True when the engine cannot continue and must be re-initialised. */
  fatal: boolean;
}

/** All labels in the loaded world (sent after world load; use ids with `setLabelContent`). */
export interface LabelsIndexEvent {
  type: 'labelsIndex';
  labels: LabelInfo[];
}

/** The ground was pressed (not on a building). */
export interface MapPressEvent {
  type: 'map:press';
  coordinate: LngLat;
}

/** A building was pressed. */
export interface BuildingPressEvent {
  type: 'building:press';
  buildingId: string;
  coordinate: LngLat;
}

/**
 * A marker was pressed.
 *
 * Takes precedence over {@link BuildingPressEvent} and {@link MapPressEvent}:
 * a press that hits a visible marker emits this event **only**.
 */
export interface MarkerPressEvent {
  type: 'marker:press';
  layerId: string;
  markerId: string;
  /** The marker's coordinate (not the pressed point). */
  coordinate: LngLat;
  /** Screen position of the marker's anchor in density-independent pixels, origin top-left. */
  point: { x: number; y: number };
}

/**
 * A drop was collected (judged instantly on the client). Forward `collectId`
 * to a server to verify the collection.
 */
export interface DropCollectEvent {
  type: 'drop:collect';
  layerId: string;
  dropId: string;
  characterId: string;
  /** Collector position at collection time. */
  coordinate: LngLat;
  /** Unique nonce for this collection, for server-side verification. */
  collectId: string;
}

/** A leg of a started travel. */
export interface TravelLeg {
  mode: TravelMode;
  meters: number;
}

/** Travel started; `legs` is the expanded mode chain (e.g. `subway` → walk, subway, walk). */
export interface TravelStartEvent {
  type: 'travel:start';
  requestId: string;
  characterId: string;
  legs: TravelLeg[];
}

/** Travel progress (subscription topic `travel:progress`). */
export interface TravelProgressEvent {
  type: 'travel:progress';
  requestId: string;
  characterId: string;
  remainingMeters: number;
  /**
   * Wall-clock seconds until arrival at the travel's `timeScale` (real-world
   * travel time divided by `timeScale`). The `route` request's `etaSeconds`
   * is the unscaled real-world time.
   */
  etaSeconds: number;
  /** Mode of the current leg. */
  mode: TravelMode;
}

/** Travel reached its destination. */
export interface TravelArriveEvent {
  type: 'travel:arrive';
  requestId: string;
  characterId: string;
}

/** Travel was cancelled (by `cancelTravel` or a newer `travel`). */
export interface TravelCancelEvent {
  type: 'travel:cancel';
  requestId: string;
  characterId: string;
}

/** A character entered a geofence. */
export interface GeofenceEnterEvent {
  type: 'geofence:enter';
  geofenceId: string;
  characterId: string;
}

/** A character left a geofence. */
export interface GeofenceExitEvent {
  type: 'geofence:exit';
  geofenceId: string;
  characterId: string;
}

/** Character position (subscription topic `character:position`). */
export interface CharacterPositionEvent {
  type: 'character:position';
  id: string;
  coordinate: LngLat;
  /** Degrees clockwise from north. */
  headingDeg: number;
  /**
   * On-map ground speed in meters per wall-clock second (what a GPS would
   * report for the animated character): real-world speed × `timeScale` while
   * travelling.
   */
  speedMps: number;
}

/** Concrete camera state reported by the engine. */
export type CameraState = Required<Pick<CameraSpec, 'center' | 'distance' | 'pitch' | 'bearing'>>;

/**
 * Camera moved (subscription topic `camera:change`).
 *
 * `camera.center` is the ground point at the centre of the **visible area**
 * (the view minus `ui.contentInset`), i.e. what `setCamera({ center })` puts
 * there.
 */
export interface CameraChangeEvent {
  type: 'camera:change';
  camera: CameraState;
}

/** What moved the camera before it came to rest. */
export const CAMERA_IDLE_REASONS = ['gesture', 'api', 'follow'] as const;
/**
 * Why the camera moved:
 *
 * - `gesture`: **user input** — a pan, pinch, rotate or wheel on the map, and
 *   the engine's own zoom buttons (`ui.zoomButtons`), which the user presses
 *   and the app never issues.
 * - `api`: **the app** moved it — `setCamera` (including the `camera` prop) or
 *   `fitBounds`. This is the one an app can predict, so it is the one worth
 *   filtering out when a move was its own doing.
 * - `follow`: the camera settled on the character it follows
 *   (`CameraSpec.follow`).
 */
export type CameraIdleReason = (typeof CAMERA_IDLE_REASONS)[number];

/**
 * How long the camera must be still before {@link CameraIdleEvent} is emitted,
 * in milliseconds. Shared by every Maprama engine so the same gesture produces
 * the same number of events on web and native.
 */
export const CAMERA_IDLE_DELAY_MS = 150;

/**
 * Ground distance limit of {@link CameraIdleEvent}, as a multiple of
 * `camera.distance`: a tilted camera can see towards the horizon, where a
 * viewport corner projects arbitrarily far away (or misses the ground plane
 * entirely). Such a corner is pulled back to
 * `CAMERA_IDLE_HORIZON_FACTOR × camera.distance` from the camera centre, which
 * is the engine's far plane — beyond it nothing is drawn, so nothing is
 * cropped that the user could have seen.
 *
 * Consequences: `radiusMeters ≤ CAMERA_IDLE_HORIZON_FACTOR × camera.distance`
 * always, and `bounds` is always a box an app can query.
 */
export const CAMERA_IDLE_HORIZON_FACTOR = 6;

/**
 * The camera came to rest (subscription topic `camera:idle`): emitted once,
 * {@link CAMERA_IDLE_DELAY_MS} after the last camera movement of a gesture, a
 * `setCamera` / `fitBounds` animation, a zoom button, or a followed character
 * settling.
 *
 * `subscribe` itself arms one event, so the first `camera:idle` arrives one
 * idle delay later and describes where the camera already is: an app can make
 * its first query without waiting for the user to touch the map.
 *
 * It answers "what is on screen now?" in one message, so a host does not have
 * to debounce `camera:change` and unproject the corners itself:
 *
 * ```ts
 * map.subscribe('camera:idle', ({ camera, radiusMeters }) => {
 *   void fetchPois(snapToGrid(camera.center), radiusMeters);
 * });
 * ```
 */
export interface CameraIdleEvent {
  type: 'camera:idle';
  /** The camera it came to rest at. `center` is the centre of the visible area. */
  camera: CameraState;
  /**
   * Axis-aligned geographic box around the ground the visible area covers
   * (the view minus `ui.contentInset`).
   *
   * At a pitch above 0 that ground area is a trapezoid, and `bounds` is the
   * north-aligned box **around** it: every visible point is inside `bounds`,
   * but not every point of `bounds` is visible. Corners that reach past the
   * horizon are clamped, see {@link CAMERA_IDLE_HORIZON_FACTOR}.
   */
  bounds: LngLatBounds;
  /**
   * Radius in meters from `camera.center` to the **farthest corner of the
   * visible area** on the ground — the circle around `camera.center` that
   * contains everything the user can see.
   *
   * It measures to the corners of the visible ground quad, not to the corners
   * of `bounds` (which is the box around that quad, so its corners are usually
   * farther out). It is deliberately the circumscribed radius and not the
   * inscribed one: a "give me everything within R of here" query must not drop
   * the POIs sitting in the corners of the screen. At a pitch above 0 the
   * farthest corner is one of the two at the top of the visible area.
   *
   * Always present — that is the point: an app can ask its server for
   * everything within `radiusMeters` of `camera.center` without re-deriving
   * the field of view.
   */
  radiusMeters: number;
  /** What moved the camera. */
  reason: CameraIdleReason;
}

/**
 * An info card was pressed: one of its action buttons when `actionId` is
 * present, the card body otherwise.
 *
 * Info cards capture their own touches, so a press on a card never also
 * produces {@link BuildingPressEvent} or {@link MapPressEvent}.
 */
export interface InfoCardPressEvent {
  type: 'infoCard:press';
  id: string;
  /** The `content.actions` entry that was pressed; absent for the card body. */
  actionId?: string;
}

/**
 * An info card's close button was pressed (`dismissible: true`).
 *
 * The engine does **not** remove the card: the app decides, by sending
 * `removeInfoCard` (or unmounting `<InfoCard>`). Keeping the decision on the
 * app side is what lets a card ask "discard your edits?" first.
 */
export interface InfoCardDismissEvent {
  type: 'infoCard:dismiss';
  id: string;
}

/**
 * The render view mode changed, or a view transition ended.
 *
 * Emitted twice for an animated switch — once with `animating: true` when it
 * starts, once with `animating: false` when it settles — and once with
 * `animating: false` for an instant switch or for a `setView` that asked for
 * the mode the engine is already in. `view` is always the mode being moved
 * **to**, so a host can flip its own 2D chrome the moment the transition starts
 * and wait for `animating: false` before measuring anything.
 */
export interface ViewChangeEvent {
  type: 'view:change';
  view: ViewMode;
  animating: boolean;
}

/** Screen position of an overlay anchor. */
export interface OverlayPosition extends ScreenPoint {
  id: string;
}

/** Screen positions of overlay anchors (sent while anchors exist and the view changes). */
export interface OverlayPositionsEvent {
  type: 'overlay:positions';
  positions: OverlayPosition[];
}

/** Error payload of a failed request. */
export interface ProtocolError {
  code: EngineErrorCode;
  message: string;
}

/** Successful response to a `request`. The result shape depends on the request's method. */
export interface ResponseOkEvent<M extends RequestMethod = RequestMethod> {
  type: 'response';
  requestId: string;
  ok: true;
  result: RequestResultMap[M];
}

/** Failed response to a `request`. */
export interface ResponseErrorEvent {
  type: 'response';
  requestId: string;
  ok: false;
  error: ProtocolError;
}

/** Response to a `request` (discriminated on `ok`). */
export type ResponseEvent = ResponseOkEvent | ResponseErrorEvent;

/** Any engine → host event (discriminated on `type`). */
export type EngineEvent =
  | ReadyEvent
  | ErrorEvent
  | LabelsIndexEvent
  | MapPressEvent
  | BuildingPressEvent
  | MarkerPressEvent
  | DropCollectEvent
  | TravelStartEvent
  | TravelProgressEvent
  | TravelArriveEvent
  | TravelCancelEvent
  | GeofenceEnterEvent
  | GeofenceExitEvent
  | CharacterPositionEvent
  | CameraChangeEvent
  | OverlayPositionsEvent
  | ResponseEvent
  | CameraIdleEvent
  | InfoCardPressEvent
  | InfoCardDismissEvent
  | ViewChangeEvent;

/** Event `type` tag. */
export type EngineEventType = EngineEvent['type'];

// ---------------------------------------------------------------------------
// Envelope & codec
// ---------------------------------------------------------------------------

/** Envelope kinds: `cmd` (host → engine) or `evt` (engine → host). */
export type MessageKind = 'cmd' | 'evt';

/** Wire envelope around every message. */
export interface Envelope<T> {
  /** Protocol version, {@link PROTOCOL_VERSION}. */
  v: typeof PROTOCOL_VERSION;
  /** Sender-local sequence number (non-negative integer, increasing). */
  seq: number;
  kind: MessageKind;
  msg: T;
}

/** Envelope carrying a command. */
export type CommandEnvelope = Envelope<EngineCommand> & { kind: 'cmd' };

/** Envelope carrying an event. */
export type EventEnvelope = Envelope<EngineEvent> & { kind: 'evt' };

/** Result of decoding; decoding never throws. */
export type DecodeResult<T> = { ok: true; value: T } | { ok: false; error: string };

const id = nonEmptyString;

const requestChecks: { [M in RequestMethod]: Check } = {
  project: object({ coordinate: checkLngLat }),
  unproject: object({ x: number, y: number }),
  snapToRoad: object({ coordinate: checkLngLat }, { maxDistanceMeters: nonNegativeNumber }),
  snapToBuilding: object({ coordinate: checkLngLat }, { maxDistanceMeters: nonNegativeNumber }),
  route: object({ from: checkLngLat, to: checkLngLat, modes: array(oneOf(TRAVEL_MODES), { min: 1 }) }),
  fitBounds: object(
    { bounds: checkLngLatBounds },
    {
      padding: anyOf(
        nonNegativeNumber,
        object({}, { top: nonNegativeNumber, right: nonNegativeNumber, bottom: nonNegativeNumber, left: nonNegativeNumber }),
      ),
      pitch: range(0, 90),
      bearing: number,
      orientation: oneOf(FIT_BOUNDS_ORIENTATIONS),
      animate: anyOf(boolean, object({ durationMs: nonNegativeNumber })),
    },
  ),
  // Appended after `fitBounds`, so the index engines derive from REQUEST_METHODS stays stable.
  focusOn: (v, p) => {
    const err = object(
      {},
      {
        coordinate: checkLngLat,
        infoCardId: nonEmptyString,
        distance: positiveNumber,
        pitch: range(0, 90),
        bearing: number,
        heightMeters: nonNegativeNumber,
        animate: anyOf(boolean, object({ durationMs: nonNegativeNumber })),
        inset: boolean,
      },
    )(v, p);
    if (err) return err;
    const t = v as { coordinate?: unknown; infoCardId?: unknown };
    const given = (t.coordinate !== undefined ? 1 : 0) + (t.infoCardId !== undefined ? 1 : 0);
    return given === 1 ? null : `${p}: exactly one of "coordinate" / "infoCardId" is required`;
  },
};

const subscriptionTopic = oneOf(SUBSCRIPTION_TOPICS);

const commandChecks: { [K in EngineCommandType]: Check } = {
  init: object(
    {
      world: checkWorldSource,
      theme: checkThemeSpec,
      labels: checkLabelsSpec,
      ui: checkMapUiSpec,
      locationSource: oneOf(LOCATION_SOURCE_KINDS),
    },
    { camera: checkCameraSpec, view: checkViewMode },
  ),
  setTheme: object({ theme: checkThemeSpec }),
  setLabels: object({ labels: checkLabelsSpec }),
  setLabelContent: object({ entries: record(checkLabelContent) }),
  setUi: object({ ui: checkMapUiSpec }),
  setCamera: object({ camera: checkCameraSpec }),
  upsertCharacters: object({ characters: array(checkCharacterSpec) }),
  removeCharacters: object({ ids: array(id) }),
  setLocationSource: object({ source: oneOf(LOCATION_SOURCE_KINDS) }),
  pushLocation: object({ fix: checkLocationFix }),
  travel: object(
    {
      requestId: id,
      characterId: id,
      to: checkLngLat,
      modes: array(oneOf(TRAVEL_MODES), { min: 1 }),
    },
    { timeScale: positiveNumber },
  ),
  cancelTravel: object({ characterId: id }),
  setDropLayer: object(
    { layerId: id, drops: array(checkDropSpec), collectRadiusMeters: nonNegativeNumber },
    { collectorIds: array(id) },
  ),
  removeDropLayer: object({ layerId: id }),
  setGeofences: object({ geofences: array(checkGeofenceSpec) }),
  setBuildingStyle: object({ buildingId: id, style: nullable(checkBuildingStyle) }),
  setOverlayAnchors: object({ anchors: array(object({ id, coordinate: checkLngLat })) }),
  subscribe: object({ topic: subscriptionTopic, throttleMs: nonNegativeNumber }, { id }),
  unsubscribe: object({ topic: subscriptionTopic }, { id }),
  request: (v, p) => {
    const err = object({ requestId: id, method: oneOf(REQUEST_METHODS), params: object({}) })(v, p);
    if (err) return err;
    const req = v as { method: RequestMethod; params: unknown };
    return requestChecks[req.method](req.params, `${p}.params`);
  },
  // Commands added after the first release are appended here, so the order of
  // ENGINE_COMMAND_TYPES (and the index engines derive from it) stays stable.
  setMarkerLayer: object(
    { layerId: id, markers: array(checkMarkerSpec) },
    {
      selectedId: nullable(nonEmptyString),
      selectedScale: positiveNumber,
      size: positiveNumber,
      anchor: oneOf(MARKER_ANCHORS),
    },
  ),
  removeMarkerLayer: object({ layerId: id }),
  setInfoCard: object({ card: checkInfoCardSpec }),
  removeInfoCard: object({ id }),
  // view.ts, appended after the info-card commands.
  setView: object({ view: checkViewMode }, { animate: anyOf(boolean, object({ durationMs: nonNegativeNumber })) }),
};

const cameraState: Check = object({
  center: checkLngLat,
  distance: number,
  pitch: range(0, 90),
  bearing: number,
});

const travelRef = { requestId: id, characterId: id };
const geofenceRef = object({ geofenceId: id, characterId: id });
const protocolError = object({ code: string, message: string });

const eventChecks: { [K in EngineEventType]: Check } = {
  ready: object({ engine: object({ name: string, version: string, kind: oneOf(ENGINE_KINDS) }) }),
  error: object({ code: string, message: string, fatal: boolean }),
  labelsIndex: object({ labels: array(checkLabelInfo) }),
  'map:press': object({ coordinate: checkLngLat }),
  'building:press': object({ buildingId: id, coordinate: checkLngLat }),
  'drop:collect': object({ layerId: id, dropId: id, characterId: id, coordinate: checkLngLat, collectId: id }),
  'travel:start': object({
    ...travelRef,
    legs: array(object({ mode: oneOf(TRAVEL_MODES), meters: nonNegativeNumber })),
  }),
  'travel:progress': object({
    ...travelRef,
    remainingMeters: nonNegativeNumber,
    etaSeconds: nonNegativeNumber,
    mode: oneOf(TRAVEL_MODES),
  }),
  'travel:arrive': object(travelRef),
  'travel:cancel': object(travelRef),
  'geofence:enter': geofenceRef,
  'geofence:exit': geofenceRef,
  'character:position': object({ id, coordinate: checkLngLat, headingDeg: number, speedMps: number }),
  'camera:change': object({ camera: cameraState }),
  'overlay:positions': object({
    positions: array(object({ id, x: number, y: number, visible: boolean })),
  }),
  response: (v, p) => {
    const err = object({ requestId: id, ok: boolean })(v, p);
    if (err) return err;
    return (v as { ok: boolean }).ok
      ? object({ result: json })(v, p)
      : object({ error: protocolError })(v, p);
  },
  // Appended for the same reason as the new commands above.
  'marker:press': object({
    layerId: id,
    markerId: id,
    coordinate: checkLngLat,
    point: object({ x: number, y: number }),
  }),
  'camera:idle': object({
    camera: cameraState,
    bounds: checkLngLatBounds,
    radiusMeters: nonNegativeNumber,
    reason: oneOf(CAMERA_IDLE_REASONS),
  }),
  'infoCard:press': object({ id }, { actionId: nonEmptyString }),
  'infoCard:dismiss': object({ id }),
  'view:change': object({ view: checkViewMode, animating: boolean }),
};

/** Every command `type`, in declaration order. */
export const ENGINE_COMMAND_TYPES = Object.freeze(Object.keys(commandChecks)) as readonly EngineCommandType[];

/** Every event `type`, in declaration order. */
export const ENGINE_EVENT_TYPES = Object.freeze(Object.keys(eventChecks)) as readonly EngineEventType[];

const checkEngineCommand: Check = discriminated('type', commandChecks);
const checkEngineEvent: Check = discriminated('type', eventChecks);

/**
 * Validates an unknown value as an {@link EngineCommand}: `type` must be known
 * and required fields present with the right types. Extra fields are allowed.
 * Never throws.
 */
export function validateEngineCommand(value: unknown): ValidationResult {
  return run(checkEngineCommand, value);
}

/**
 * Validates an unknown value as an {@link EngineEvent}. For `response` events
 * only JSON-ness of `result` is checked, because its shape depends on the
 * request method (correlate by `requestId`). Never throws.
 */
export function validateEngineEvent(value: unknown): ValidationResult {
  return run(checkEngineEvent, value);
}

function assertSeq(seq: number, fn: string): void {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new RangeError(`${fn}: seq must be a non-negative safe integer, got ${seq}`);
  }
}

/**
 * Wraps a command in an envelope and serialises it to a JSON string.
 * Does not validate the message (the receiver does).
 *
 * @throws RangeError if `seq` is not a non-negative safe integer.
 */
export function encodeCommand(command: EngineCommand, seq: number): string {
  assertSeq(seq, 'encodeCommand');
  const envelope: CommandEnvelope = { v: PROTOCOL_VERSION, seq, kind: 'cmd', msg: command };
  return JSON.stringify(envelope);
}

/**
 * Wraps an event in an envelope and serialises it to a JSON string.
 * Does not validate the message (the receiver does).
 *
 * @throws RangeError if `seq` is not a non-negative safe integer.
 */
export function encodeEvent(event: EngineEvent, seq: number): string {
  assertSeq(seq, 'encodeEvent');
  const envelope: EventEnvelope = { v: PROTOCOL_VERSION, seq, kind: 'evt', msg: event };
  return JSON.stringify(envelope);
}

function decodeEnvelope<T>(data: unknown, kind: MessageKind, msgCheck: Check): DecodeResult<T> {
  if (typeof data !== 'string') {
    return { ok: false, error: `$: expected JSON string, got ${data === null ? 'null' : typeof data}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (e) {
    return { ok: false, error: `$: invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isRecord(parsed)) return { ok: false, error: '$: expected envelope object' };
  if (parsed.v !== PROTOCOL_VERSION) {
    return {
      ok: false,
      error: `$.v: unsupported protocol version ${JSON.stringify(parsed.v)} (expected ${PROTOCOL_VERSION})`,
    };
  }
  if (parsed.kind !== kind) {
    return { ok: false, error: `$.kind: expected ${JSON.stringify(kind)}, got ${JSON.stringify(parsed.kind)}` };
  }
  const seqResult = run(nonNegativeInteger, parsed.seq, '$.seq');
  if (!seqResult.ok) return seqResult;
  if (parsed.msg === undefined) return { ok: false, error: '$.msg: required field is missing' };
  const msgResult = run(msgCheck, parsed.msg, '$.msg');
  if (!msgResult.ok) return msgResult;
  return { ok: true, value: parsed as T };
}

/** Parses and validates a command envelope from a JSON string. Never throws. */
export function decodeCommand(data: string): DecodeResult<CommandEnvelope> {
  return decodeEnvelope<CommandEnvelope>(data, 'cmd', checkEngineCommand);
}

/** Parses and validates an event envelope from a JSON string. Never throws. */
export function decodeEvent(data: string): DecodeResult<EventEnvelope> {
  return decodeEnvelope<EventEnvelope>(data, 'evt', checkEngineEvent);
}
