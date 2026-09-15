/**
 * Public prop and API types. They wrap `@maprama/protocol` types; protocol
 * types are re-exported from the package entry and never redefined here.
 *
 * @module
 */

import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import type {
  AnimationName,
  BuildingStyle,
  CameraSpec,
  CameraState,
  DropSpec,
  DropType,
  EngineEvent,
  EngineEventType,
  EngineInfo,
  JsonValue,
  LabelContent,
  LabelContentMode,
  LabelInfo,
  LabelsSpec,
  LngLat,
  LocationFix,
  LocationSourceKind,
  MapUiSpec,
  ModelSource,
  Rarity,
  RequestMethod,
  RequestParamsMap,
  RequestResultMap,
  RouteResult,
  ScreenPoint,
  SnapToRoadResult,
  SubscriptionTopic,
  ThemeSpec,
  TravelLeg,
  TravelMode,
  WorldSource,
} from '@maprama/protocol';
import type { MapramaErrorCode } from './errors';

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/**
 * A 3D model reference: a bundled asset (`require('./hero.glb')`, resolved with
 * `Image.resolveAssetSource`), a URI string, or a protocol {@link ModelSource}.
 */
export type ModelInput = number | string | ModelSource;

/** An error reported through `onError`. */
export interface MapramaErrorEvent {
  /** Engine code (e.g. `unsupported`, `world_load_failed`) or host code (e.g. `invalid_message`). */
  code: MapramaErrorCode;
  message: string;
  /**
   * True when the map cannot continue (the engine must be re-initialised). For
   * `drops_fetch_failed` it means the error is permanent (e.g. `INVALID_KEY`):
   * that `DropLayer` stopped fetching until its service config changes, while
   * the map keeps running.
   */
  fatal: boolean;
}

/** Extracts the engine event with the given `type`. */
export type EngineEventOf<T extends EngineEventType> = Extract<EngineEvent, { type: T }>;

// ---------------------------------------------------------------------------
// MapramaView
// ---------------------------------------------------------------------------

/**
 * Computes the content of one label. Evaluated in JavaScript (never per frame)
 * for every label:
 * - once per `labelsIndex` event (when the world loads),
 * - once when a non-function field of `labels` changes (e.g. `style`),
 * - when `ref.refreshLabelContent()` is called.
 *
 * The latest function is always used, but a new function identity alone (an
 * inline arrow re-created on every render) does not trigger re-evaluation; call
 * `refreshLabelContent()` when the data it reads changes. Return `null` or
 * `undefined` to keep the label's default name.
 */
export type LabelContentFunction = (label: LabelInfo) => LabelContent | null | undefined;

/** Label configuration (`labels` prop). */
export interface MapramaLabelsProps extends Omit<LabelsSpec, 'content'> {
  /**
   * A content mode, or a function computing custom content per label (the
   * engine receives `content: 'custom'` plus `setLabelContent` entries).
   */
  content?: LabelContentMode | LabelContentFunction;
}

/**
 * How `location.source: 'device'` obtains positions:
 * - `auto` (default): `expo-location` when installed, otherwise `webview`.
 * - `expo-location`: the host watches `expo-location` and pushes fixes (the engine runs with the `external` source).
 * - `webview`: the engine reads `navigator.geolocation` inside the WebView.
 */
export type DeviceLocationProvider = 'auto' | 'expo-location' | 'webview';

/** Location configuration (`location` prop). */
export interface MapramaLocationProps {
  /**
   * `device` (GPS), `external` (push fixes with `ref.pushLocation`) or
   * `simulated` (demo loop). Default `external`.
   */
  source: LocationSourceKind;
  /** Device location provider for `source: 'device'`. Default `auto`. */
  provider?: DeviceLocationProvider;
}

/** Payload of `onReady`. */
export interface MapramaReadyEvent {
  engine: EngineInfo;
}

/** Payload of `onPress`. */
export interface MapramaPressEvent {
  /** Ground coordinate that was pressed. */
  coordinate: LngLat;
}

/** Payload of `onBuildingPress`. */
export interface MapramaBuildingPressEvent {
  buildingId: string;
  coordinate: LngLat;
}

/** Props of `MapramaView`. */
export interface MapramaViewProps {
  /** The world to load: `{kind:'url', url}`, `{kind:'data', world}` or `{kind:'procedural', layout}`. Read at init. */
  world: WorldSource;
  /** Visual theme. Changes send `setTheme`. */
  theme?: ThemeSpec;
  /** Label configuration. Changes send `setLabels`; a `content` function sends `setLabelContent`. */
  labels?: MapramaLabelsProps;
  /** Map UI elements drawn by the engine. Changes send `setUi`. */
  ui?: MapUiSpec;
  /**
   * Declarative camera. Only fields that changed since the last update are sent
   * (`setCamera`); removing `follow` sends `follow: null`. Use `ref.setCamera` for one-off moves.
   */
  camera?: CameraSpec;
  /** Player location source. Default `{ source: 'external' }`. */
  location?: MapramaLocationProps;
  /** Engine host kind (see `registerEngineHost`). Default `'web'`. Read at mount. */
  engine?: string;
  /**
   * Default timeout for request/response calls such as `project`. Default 5000 ms.
   * The current value is read whenever a timer is armed: at the call (bounding
   * the wait for the engine to become ready) and again when the queued request
   * reaches the engine (the timeout restarts from delivery).
   */
  requestTimeoutMs?: number;
  /**
   * Time a `travel` may wait for `travel:start` before it rejects with `timeout`.
   * Default 10000 ms. Read like `requestTimeoutMs`: at the call (bounding the wait
   * for the engine to become ready) and again from delivery.
   */
  travelStartTimeoutMs?: number;
  /** The engine loaded and received `init` (fires again after an engine reload). */
  onReady?: (event: MapramaReadyEvent) => void;
  /** The ground was pressed. */
  onPress?: (event: MapramaPressEvent) => void;
  /** A building was pressed. */
  onBuildingPress?: (event: MapramaBuildingPressEvent) => void;
  /**
   * Engine errors, invalid engine messages and host failures. The map never
   * throws for these. A fatal host failure (`host_load_failed`, or no host for
   * `engine`) also rejects every pending request and travel with that code.
   */
  onError?: (event: MapramaErrorEvent) => void;
  /** Style of the map container (e.g. `{ flex: 1 }`). */
  style?: StyleProp<ViewStyle>;
  /** Test id of the container view. */
  testID?: string;
  /** `Character`, `CharacterLayer`, `DropLayer`, `Geofence` and `MapOverlay` elements (other views render on top of the map). */
  children?: ReactNode;
}

// ---------------------------------------------------------------------------
// Ref API
// ---------------------------------------------------------------------------

/** Result of a completed `travel`. */
export interface TravelResult {
  requestId: string;
  characterId: string;
  /** Expanded legs reported by `travel:start`. */
  legs: TravelLeg[];
}

/** Options for `travel`. */
export interface TravelOptions {
  /** Rejects with `timeout` (and sends `cancelTravel`) if the travel has not arrived after this many ms. No limit by default. */
  timeoutMs?: number;
  /** Overrides the map's `travelStartTimeoutMs` for this call. */
  startTimeoutMs?: number;
}

/** Options for request/response calls. */
export interface RequestOptions {
  /** Overrides the map's `requestTimeoutMs`. */
  timeoutMs?: number;
}

/** Options for `subscribe`. */
export interface SubscribeOptions {
  /** Character id for `character:position` / `travel:progress`; all characters when absent. */
  id?: string;
  /** Minimum interval between deliveries in ms. Default 250. */
  throttleMs?: number;
}

/** Events delivered per subscription topic. */
export interface SubscriptionEventMap {
  'character:position': EngineEventOf<'character:position'>;
  'camera:change': EngineEventOf<'camera:change'>;
  'travel:progress': EngineEventOf<'travel:progress'>;
}

/** Imperative map API, available through `ref` on `MapramaView` and `useMapramaView()`. */
export interface MapramaViewRef {
  /**
   * Moves a character along an ordered mode chain, e.g. `['walk', 'car', 'walk']`.
   * Resolves on `travel:arrive`; rejects with `MapramaError` code
   * `travel_cancelled`, `timeout`, `engine_reloaded`, `unmounted`, or a fatal
   * host code such as `host_load_failed`.
   *
   * Timeouts: the start timeout (`startTimeoutMs`, default the map's
   * `travelStartTimeoutMs`) is armed at the call, so a travel made before the
   * engine is ready rejects with `timeout` if the engine does not become ready in
   * time; once the travel reaches the engine both timeouts restart from delivery.
   */
  travel(characterId: string, to: LngLat, modes?: TravelMode | TravelMode[], options?: TravelOptions): Promise<TravelResult>;
  /** Cancels the character's current travel (its promise rejects with `travel_cancelled`). */
  cancelTravel(characterId: string): void;
  /** Moves the camera; unset fields keep their current value. */
  setCamera(camera: CameraSpec): void;
  /** Injects a location fix (effective with `location.source: 'external'`). */
  pushLocation(fix: LocationFix): void;
  /** Sets (or clears with `null`) a per-building style override. */
  setBuildingStyle(buildingId: string, style: BuildingStyle | null): void;
  /** Geographic coordinate → screen point in dp. */
  project(coordinate: LngLat, options?: RequestOptions): Promise<ScreenPoint>;
  /** Screen point in dp → ground coordinate (`null` when it misses the ground). */
  unproject(point: { x: number; y: number }, options?: RequestOptions): Promise<LngLat | null>;
  /** Nearest point on the road network, or `null` when none is within range. */
  snapToRoad(coordinate: LngLat, maxDistanceMeters?: number, options?: RequestOptions): Promise<SnapToRoadResult | null>;
  /** Plans a route without moving anything. */
  route(from: LngLat, to: LngLat, modes?: TravelMode[], options?: RequestOptions): Promise<RouteResult>;
  /**
   * Low-level request/response call. Rejects with the engine's error code,
   * `timeout`, `engine_reloaded`, `unmounted` or a fatal host code such as
   * `host_load_failed`. The timeout (`options.timeoutMs`, default the map's
   * `requestTimeoutMs`) is armed at the call, so a call made before the engine is
   * ready cannot hang; it restarts when the request reaches the engine.
   */
  request<M extends RequestMethod>(method: M, params: RequestParamsMap[M], options?: RequestOptions): Promise<RequestResultMap[M]>;
  /**
   * Opts in to a throttled continuous stream. The engine subscription is shared
   * and reference-counted; it is cancelled when the last listener unsubscribes.
   * Returns the unsubscribe function.
   */
  subscribe<T extends SubscriptionTopic>(
    topic: T,
    listener: (event: SubscriptionEventMap[T]) => void,
    options?: SubscribeOptions,
  ): () => void;
  /** Listens to every engine event of one type. Returns the unsubscribe function. */
  addEventListener<T extends EngineEventType>(type: T, listener: (event: EngineEventOf<T>) => void): () => void;
  /** Engine info once ready, otherwise `null`. */
  getEngineInfo(): EngineInfo | null;
  /** True after `init` was sent to a ready engine. */
  isReady(): boolean;
  /**
   * Re-evaluates a `labels.content` function for every label of the latest
   * `labelsIndex` and sends the result with the next frame's `setLabelContent`
   * (the whole content map is sent again when it differs from the last one sent;
   * nothing is sent when it is unchanged). Call it when data read by the function
   * changes; a new function identity alone does not re-evaluate. No-op when
   * `labels.content` is not a function or the world has not reported its labels.
   */
  refreshLabelContent(): void;
}

/** Position of a character, as returned by `useCharacterPosition`. */
export interface CharacterPosition {
  coordinate: LngLat;
  /** Degrees clockwise from north. */
  headingDeg: number;
  speedMps: number;
}

/** A `MapramaViewRef`, a React ref holding one, or nothing. Accepted by the hooks. */
export type MapramaViewRefLike = MapramaViewRef | { readonly current: MapramaViewRef | null } | null | undefined;

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** Props of `Character`. */
export interface CharacterProps {
  /** Stable id, unique across characters. */
  id: string;
  /** The local player (at most one); default collector for drops. */
  isPlayer?: boolean;
  /** glTF/GLB model; the engine's default avatar when absent. */
  model?: ModelInput;
  /** Maps conventional animation names to clip names in the model. */
  animations?: Partial<Record<AnimationName, string>>;
  /** `location`: driven by the location source; `none`: moved only by commands. */
  follow?: 'location' | 'none';
  /** Initial or teleport position (changing it teleports the character). */
  position?: LngLat;
  /** Display name. */
  name?: string;
  /** Accent color as CSS hex (`'#2F5BEA'`). */
  color?: string;
  /** Uniform model scale. Default 1. */
  scale?: number;
  /** Show a floating name tag. */
  showNameTag?: boolean;
}

/** Props of `CharacterLayer`: many characters from app data. */
export interface CharacterLayerProps<T> {
  data: readonly T[];
  /** Stable character id per item. */
  getId: (item: T) => string;
  /** Current position per item (changes teleport the character). */
  getPosition: (item: T) => LngLat;
  getModel?: (item: T) => ModelInput | undefined;
  getName?: (item: T) => string | undefined;
  getColor?: (item: T) => string | undefined;
  getScale?: (item: T) => number | undefined;
  getAnimations?: (item: T) => Partial<Record<AnimationName, string>> | undefined;
  /** Show name tags for all characters of the layer. */
  showNameTags?: boolean;
}

/** Payload of `DropLayer` `onCollect`: the engine's `drop:collect` plus the drop's payload. */
export interface DropCollectInfo {
  layerId: string;
  dropId: string;
  characterId: string;
  /** Collector position at collection time. */
  coordinate: LngLat;
  /** Collection nonce for server-side verification. */
  collectId: string;
  /** The drop's `payload` (`getPayload` result or service payload), `undefined` when none. */
  payload: JsonValue | undefined;
}

/** Payload of `onCollectVerified` (`source="service"`). */
export interface DropCollectVerifiedInfo extends DropCollectInfo {
  /** Signed receipt from `POST /v1/drops/collect`. */
  receipt: string;
  /** True when the service returned the receipt of an earlier identical collect. */
  replayed: boolean;
}

/** Payload of `onCollectRejected` (`source="service"`). */
export interface DropCollectRejectedInfo extends DropCollectInfo {
  /** Service error code (e.g. `TOO_FAR`, `ALREADY_COLLECTED`), or `NETWORK_ERROR` / `INVALID_RESPONSE`. */
  code: string;
  message: string;
  /** HTTP status, `0` for network failures. */
  status: number;
}

/** Props shared by both `DropLayer` sources. */
export interface DropLayerBaseProps {
  /** Layer id, unique per map. */
  id: string;
  /** A drop is collected within this many meters of a collector. Default 15. */
  collectRadiusMeters?: number;
  /** Characters that can collect; the player by default. */
  collectorIds?: string[];
  /** A drop of this layer was collected (judged on the device). */
  onCollect?: (event: DropCollectInfo) => void;
}

/** `DropLayer` fed from app data. */
export interface DataDropLayerProps<T> extends DropLayerBaseProps {
  source?: 'data';
  data: readonly T[];
  getId: (item: T) => string;
  getCoordinate: (item: T) => LngLat;
  /** Visual type. Default `'coin'`. */
  getType?: (item: T) => DropType;
  getRarity?: (item: T) => Rarity | undefined;
  getValue?: (item: T) => number | undefined;
  /** Custom model (required for type `'model'`). */
  getModel?: (item: T) => ModelInput | undefined;
  /** JSON payload echoed in `onCollect`. */
  getPayload?: (item: T) => JsonValue | undefined;
}

/**
 * `DropLayer` fed by the hosted service: fetches
 * `GET {baseUrl}/v1/drops/nearby` around the player (again after moving more
 * than `refetchDistanceMeters` or when the drop window expires) and verifies
 * collections with `POST {baseUrl}/v1/drops/collect`.
 */
export interface ServiceDropLayerProps extends DropLayerBaseProps {
  source: 'service';
  /** Campaign channel. */
  channel: string;
  /** Client API key (sent as `Authorization: Bearer`). */
  apiKey: string;
  /** Service base URL, e.g. `https://api.example`. */
  baseUrl: string;
  /** App user id sent with collect verification. */
  userId: string;
  /** Search radius in meters (1..3000). Default 500. */
  radiusMeters?: number;
  /**
   * Refetch after the player moved this far from the last fetch. Default 150.
   * While a failed fetch is backing off, only a move this far from both the last
   * attempt and the last successful fetch fetches early (keeping the backoff).
   */
  refetchDistanceMeters?: number;
  /** Character whose position drives fetching. Default: the `isPlayer` character. */
  characterId?: string;
  /** Throttle of the position subscription that drives fetching, in ms. Default 1000. */
  positionThrottleMs?: number;
  /** The service verified a collection. */
  onCollectVerified?: (event: DropCollectVerifiedInfo) => void;
  /**
   * The service rejected a collection (or could not be reached). A drop hidden on
   * collect reappears for retryable codes (`TOO_FAR`, `TELEPORT`, `STALE_FIX`,
   * `QUOTA_EXCEEDED`, `NETWORK_ERROR`, `INVALID_RESPONSE`, HTTP 5xx) and stays
   * hidden otherwise (e.g. `ALREADY_COLLECTED`, `DROP_EXPIRED`, `DROP_NOT_FOUND`,
   * `COLLECT_ID_CONFLICT`).
   */
  onCollectRejected?: (event: DropCollectRejectedInfo) => void;
}

/** Props of `DropLayer`. */
export type DropLayerProps<T = unknown> = DataDropLayerProps<T> | ServiceDropLayerProps;

/** Payload of `Geofence` `onEnter` / `onExit`. */
export interface GeofenceEventInfo {
  geofenceId: string;
  characterId: string;
}

/** Props of `Geofence`. */
export interface GeofenceProps {
  /** Geofence id, unique per map. */
  id: string;
  center: LngLat;
  radiusMeters: number;
  /** A character entered the circle. */
  onEnter?: (event: GeofenceEventInfo) => void;
  /** A character left the circle. */
  onExit?: (event: GeofenceEventInfo) => void;
}

/** Which point of the overlay view sits on the coordinate. */
export type MapOverlayAnchor =
  | 'center'
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

/** Props of `MapOverlay`: a React Native view pinned to a map coordinate. */
export interface MapOverlayProps {
  coordinate: LngLat;
  /** Default `'bottom'` (the view stands on the coordinate). */
  anchor?: MapOverlayAnchor;
  /** Extra offset in dp applied after anchoring. */
  offset?: { x: number; y: number };
  /** Hide while the coordinate is off-screen. Default true. */
  hideWhenOffscreen?: boolean;
  /** Anchor id; generated when absent. */
  id?: string;
  style?: StyleProp<ViewStyle>;
  pointerEvents?: 'box-none' | 'none' | 'box-only' | 'auto';
  testID?: string;
  children?: ReactNode;
}

/** Re-exported for convenience in prop types. */
export type { CameraState, DropSpec };
