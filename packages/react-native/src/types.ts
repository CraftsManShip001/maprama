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
  FitBoundsParams,
  FitBoundsResult,
  FocusOnParams,
  FocusOnResult,
  InfoCardAnchor,
  InfoCardContent,
  InfoCardSpec,
  LngLat,
  LngLatBounds,
  LocationFix,
  LocationSourceKind,
  MapUiSpec,
  MarkerAnchor,
  MarkerIcon,
  MarkerShape,
  MarkerSpec,
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
  ViewMode,
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
  /**
   * Map UI elements drawn by the engine, plus `contentInset`. Changes send `setUi`.
   *
   * `ui.contentInset` (dp) is the space app chrome covers — a bottom sheet, a
   * top bar. The map keeps drawing across the whole view, but everything that
   * means "where the user is looking" moves into the rest: the camera centre,
   * `follow` centring, the ornaments (so a sheet can never cover the
   * attribution), label and marker placement, `ScreenPoint.visible` and the
   * `bounds` / `radiusMeters` of `camera:idle`. `project` / `unproject` keep
   * working in full-view screen coordinates.
   *
   * ```tsx
   * <MapramaView ui={{ attribution: true, contentInset: { bottom: sheetHeight } }} … />
   * ```
   */
  ui?: MapUiSpec;
  /**
   * Declarative camera. Only fields that changed since the last update are sent
   * (`setCamera`); removing `follow` sends `follow: null`. Use `ref.setCamera` for one-off moves.
   */
  camera?: CameraSpec;
  /**
   * Render view mode. Default `'2.5d'` — the tilted diorama. `'2d'` is a flat
   * map: footprints instead of extruded buildings, no shadows, no distance fog,
   * anchors on the ground, and the pitch locked at 0 (gestures included).
   *
   * Changing this prop sends `setView` with an animated transition. Nothing in
   * the engine changes the mode on its own, so this prop and `ref.setView` can
   * be mixed freely — the prop wins on the next render, as with every other
   * declarative prop.
   *
   * ```tsx
   * const [view, setView] = useState<ViewMode>('2.5d');
   * <MapramaView view={view} … />
   * <Button title="2D" onPress={() => setView('2d')} />
   * ```
   *
   * 2D is also the cheap mode: no shadow pass, no extruded geometry, far less
   * overdraw (`docs/guide/view-modes.md` has the measured numbers), so it works
   * as a fallback on low-end devices.
   */
  view?: ViewMode;
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
  /**
   * Default travel playback speed factor for `ref.travel` (finite, > 0).
   * `1` (the default) moves characters at real-world speed per mode (walk 4.8,
   * bike 15, car 30, subway 60, plane 180 km/h); `20` plays trips twenty times
   * faster. `TravelOptions.timeScale` overrides it per call. The latest value
   * is read at each `travel` call; an invalid value rejects the call with
   * `invalid_argument`.
   */
  travelTimeScale?: number;
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
  /** `Character`, `CharacterLayer`, `DropLayer`, `MarkerLayer`, `Geofence` and `MapOverlay` elements (other views render on top of the map). */
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
  /**
   * Playback speed factor for this travel (finite, > 0); overrides the map's
   * `travelTimeScale` (default 1 = real-world speed, 20 = twenty times
   * faster). `travel:progress.etaSeconds` is wall-clock time at this scale and
   * `character:position.speedMps` the on-map speed (real speed × scale);
   * `route` ETAs stay real-world. Invalid values reject with `invalid_argument`.
   */
  timeScale?: number;
}

/** Options for request/response calls. */
export interface RequestOptions {
  /** Overrides the map's `requestTimeoutMs`. */
  timeoutMs?: number;
}

/** Options of {@link MapramaViewRef.fitBounds}; everything but `timeoutMs` reaches the engine. */
export interface FitBoundsOptions extends RequestOptions, Omit<FitBoundsParams, 'bounds'> {}

/** What {@link MapramaViewRef.focusOn} frames: a coordinate, or an info card by id. */
export type FocusOnTarget = LngLat | { infoCardId: string };

/** Options of {@link MapramaViewRef.focusOn}; everything but `timeoutMs` reaches the engine. */
export interface FocusOnOptions extends RequestOptions, Omit<FocusOnParams, 'coordinate' | 'infoCardId'> {}

/** Options of {@link MapramaViewRef.setView}. */
export interface SetViewOptions {
  /** `false` switches instantly. Default `true` (an animated transition). */
  animate?: boolean;
  /** Transition duration in ms; implies `animate: true`. Default `VIEW_TRANSITION_MS` (450). */
  durationMs?: number;
}

/** Options for `subscribe`. */
export interface SubscribeOptions {
  /** Character id for `character:position` / `travel:progress`; all characters when absent. */
  id?: string;
  /**
   * Minimum interval between deliveries in ms. Default 250. For `camera:idle`
   * this is a floor between idle events, not a delay before one: the engine
   * waits the engine's idle delay (150 ms) of stillness either way.
   */
  throttleMs?: number;
}

/** Events delivered per subscription topic. */
export interface SubscriptionEventMap {
  'character:position': EngineEventOf<'character:position'>;
  'camera:change': EngineEventOf<'camera:change'>;
  'travel:progress': EngineEventOf<'travel:progress'>;
  'camera:idle': EngineEventOf<'camera:idle'>;
}

/** Imperative map API, available through `ref` on `MapramaView` and `useMapramaView()`. */
export interface MapramaViewRef {
  /**
   * Moves a character along an ordered mode chain, e.g. `['walk', 'car', 'walk']`,
   * at real-world speed × `timeScale` (`options.timeScale`, else the map's
   * `travelTimeScale`, else 1; `timeScale` is sent only when it is not 1).
   * Resolves on `travel:arrive`; rejects with `MapramaError` code
   * `travel_cancelled`, `timeout`, `engine_reloaded`, `unmounted`,
   * `invalid_argument` (bad `timeScale`, nothing sent), or a fatal host code
   * such as `host_load_failed`.
   *
   * Timeouts: the start timeout (`startTimeoutMs`, default the map's
   * `travelStartTimeoutMs`) is armed at the call, so a travel made before the
   * engine is ready rejects with `timeout` if the engine does not become ready in
   * time; once the travel reaches the engine both timeouts restart from delivery.
   */
  travel(characterId: string, to: LngLat, modes?: TravelMode | TravelMode[], options?: TravelOptions): Promise<TravelResult>;
  /** Cancels the character's current travel (its promise rejects with `travel_cancelled`). */
  cancelTravel(characterId: string): void;
  /**
   * Moves the camera; unset fields keep their current value. Also the place to
   * change `minDistanceMeters` / `maxDistanceMeters` after mount.
   */
  setCamera(camera: CameraSpec): void;
  /**
   * Switches the render view mode (see the `view` prop for what 2D means).
   *
   * Resolves when the transition has settled — so `await` it before measuring
   * or screenshotting — or immediately for `animate: false` and for a mode the
   * engine is already in. A second `setView` during a transition retargets it
   * from where the map is now; both calls then resolve together when it lands.
   * It never rejects: if the engine goes away mid-transition (unmount, reload)
   * the promise simply resolves.
   *
   * ```tsx
   * await map.current?.setView('2d', { durationMs: 400 });
   * ```
   */
  setView(view: ViewMode, options?: SetViewOptions): Promise<void>;
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
   * Frames a geographic box and moves the camera there, honouring the current
   * `minDistanceMeters` / `maxDistanceMeters`.
   *
   * `padding` is in dp. By default the current pitch and bearing are kept, and
   * only dropped to straight-down-to-north when that is the only way the box
   * fits (`options.orientation`). Resolves with the camera it moved to plus
   * `fitted` — false when the box is larger than `maxDistanceMeters` allows, so
   * the app can widen the limit, drop a pin from the set, or live with it.
   *
   * ```ts
   * const { fitted } = await map.current.fitBounds(boundsOfMyPins, { padding: { top: 80, bottom: 160, left: 16, right: 16 }, animate: true });
   * ```
   */
  fitBounds(bounds: LngLatBounds, options?: FitBoundsOptions): Promise<FitBoundsResult>;
  /**
   * Frames one point — and the column of air above it, where an `<InfoCard>`
   * floats — and moves the camera there, honouring the current
   * `minDistanceMeters` / `maxDistanceMeters`.
   *
   * Same character as {@link fitBounds}: a request, not an order. It resolves
   * with the camera it moved to plus `fitted` (false when the limits did not
   * allow framing the whole target) and `distanceLimited`. A newer `focusOn`
   * does not cancel an older one — both resolve, and the camera simply ends up
   * where the newer one asked, exactly like two `setCamera` calls.
   *
   * **The engine never calls this by itself.** Wiring "tap a marker → focus →
   * show a card" is the app's job:
   *
   * ```tsx
   * const onPress = async (e: MarkerPressInfo) => {
   *   await map.current?.focusOn(e.coordinate, { pitch: 55, animate: true });
   *   setCard(await loadPlace(e.markerId));   // renders an <InfoCard>
   * };
   * ```
   */
  focusOn(target: FocusOnTarget, options?: FocusOnOptions): Promise<FocusOnResult>;
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

// ---------------------------------------------------------------------------
// MarkerLayer
// ---------------------------------------------------------------------------

/**
 * A marker icon: the built-in base shape `'pin'` / `'dot'`, a URI string
 * (`data:image/svg+xml;…` or `https://…`), a bundled asset (`require('./pin.svg')`)
 * or a protocol {@link MarkerIcon}.
 */
export type MarkerIconInput = MarkerIcon | MarkerShape | string | number;

/** Payload of `MarkerLayer` `onPress`. */
export interface MarkerPressInfo {
  layerId: string;
  markerId: string;
  /** The marker's coordinate. */
  coordinate: LngLat;
  /** Screen position of the marker's anchor in dp — where to open a sheet or popover. */
  point: { x: number; y: number };
}

/**
 * Props of `MarkerLayer`: app-owned pins drawn by the engine at a fixed screen
 * size, with collision, z-ordering and accessibility.
 */
export interface MarkerLayerProps<T> {
  /** Layer id, unique per map. */
  id: string;
  data: readonly T[];
  /** Stable marker id per item. */
  getId: (item: T) => string;
  getCoordinate: (item: T) => LngLat;
  /** Base shape or custom icon. Default `'pin'`. */
  getIcon?: (item: T) => MarkerIconInput | undefined;
  /** Tint of the base shape as CSS hex (`'#2F5BEA'`). Changing it never reloads the icon. */
  getColor?: (item: T) => string | undefined;
  /** Collision priority; higher wins. Default 0. */
  getPriority?: (item: T) => number | undefined;
  /** Never hidden by collision. Default false. */
  getAlwaysVisible?: (item: T) => boolean | undefined;
  /** Text a screen reader announces, e.g. `` `${title}, ${faction}` ``. */
  getAccessibilityLabel?: (item: T) => string | undefined;
  /** Marker drawn selected: scaled by `selectedScale` and never hidden. */
  selectedId?: string | null;
  /** Scale of the selected marker. Default 1.25. */
  selectedScale?: number;
  /** Marker height in dp. Default 36. */
  size?: number;
  /** Which point of the marker sits on the coordinate. Default `'bottom'` (the pin tip). */
  anchor?: MarkerAnchor;
  /**
   * A marker of this layer was pressed. The press emits `marker:press` only:
   * the map's `onPress` / `onBuildingPress` do not fire for it.
   */
  onPress?: (event: MarkerPressInfo) => void;
}

/** Payload of `InfoCard` `onPress`. */
export interface InfoCardPressInfo {
  id: string;
  /** The `actions` entry that was pressed; absent when the card body was pressed. */
  actionId?: string;
}

/** Payload of `InfoCard` `onDismiss`. */
export interface InfoCardDismissInfo {
  id: string;
}

/**
 * Props of `InfoCard`: a holographic place card the engine draws floating over
 * a coordinate, in the same visual language as the `holo` labels.
 *
 * Several cards can be mounted at once; `id` is the key. The engine only draws
 * the card — it does not open it on a press and it does not move the camera.
 * Use `ref.focusOn` for the camera and mount / unmount the card yourself; see
 * the guide for the full "tap → focus → card" wiring.
 *
 * `content` is a fixed schema, not host markup: the same card has to be
 * drawable by both engines and readable by a screen reader in a defined order.
 * For free rendering use `<MapOverlay>` with `ref.project` instead.
 */
export interface InfoCardProps {
  /** Card id, unique per map. Also what `onPress` / `onDismiss` report. */
  id: string;
  coordinate: LngLat;
  /**
   * Where the beam starts. `'auto'` (the default) puts it on the roof of the
   * building under the coordinate, otherwise on the ground.
   */
  anchor?: InfoCardAnchor;
  /** How far above the anchor the card floats, in metres. Engine default per anchor kind. */
  heightMeters?: number;
  content: InfoCardContent;
  /** Draw the ground dot and the leader line. Default true. */
  beam?: boolean;
  /** Show a close button, which fires `onDismiss` (the card stays until you unmount it). */
  dismissible?: boolean;
  /** The card body or one of its action buttons was pressed. */
  onPress?: (event: InfoCardPressInfo) => void;
  /** The close button was pressed. The engine does not remove the card — you decide. */
  onDismiss?: (event: InfoCardDismissInfo) => void;
}

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
export type { CameraState, DropSpec, InfoCardSpec, MarkerSpec };
