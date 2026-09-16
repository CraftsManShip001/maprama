/**
 * `@maprama/react-native`: a 2.5D game map for React Native.
 *
 * - {@link MapramaView} with {@link Character}, {@link CharacterLayer}, {@link DropLayer},
 *   {@link MarkerLayer}, {@link Geofence} and {@link MapOverlay} children.
 * - Imperative API via `ref` ({@link MapramaViewRef}) or {@link useMapramaView}.
 * - Opt-in continuous values with {@link useCharacterPosition}, {@link useCameraState}
 *   and {@link useCameraIdle} ("the camera stopped; here is what is on screen").
 * - Swappable engine hosts via {@link registerEngineHost}.
 *
 * @packageDocumentation
 */

export { MapramaView } from './MapramaView';
export { Character } from './components/Character';
export { CharacterLayer } from './components/CharacterLayer';
export {
  DropLayer,
  DEFAULT_COLLECT_RADIUS_METERS,
  DEFAULT_POSITION_THROTTLE_MS,
  DEFAULT_REFETCH_DISTANCE_METERS,
  DROPS_FETCH_RETRY_DELAYS_MS,
  shouldRestoreRejectedDrop,
} from './components/DropLayer';
export { Geofence } from './components/Geofence';
export { MapOverlay } from './components/MapOverlay';
export {
  MarkerLayer,
  resolveMarkerIcon,
  DEFAULT_MARKER_SIZE,
  DEFAULT_SELECTED_SCALE,
} from './components/MarkerLayer';

export { useMapramaView } from './hooks/useMapramaView';
export { useCharacterPosition, type UseCharacterPositionOptions } from './hooks/useCharacterPosition';
export { useCameraState, type UseCameraStateOptions } from './hooks/useCameraState';
export { useCameraIdle, type CameraIdle, type UseCameraIdleOptions } from './hooks/useCameraIdle';

export { MapramaError, normalizeErrorCode, type MapramaErrorCode, type HostErrorCode } from './errors';
export { DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_THROTTLE_MS, DEFAULT_TRAVEL_START_TIMEOUT_MS } from './ref';
export { resolveModel } from './model';

export {
  createMessageChannelHost,
  type EngineHost,
  type EngineHostComponent,
  type EngineHostComponentProps,
  type EngineHostError,
  type EngineHostOptions,
  type MessageChannelHost,
} from './host/EngineHost';
export { WebViewEngineHost } from './host/WebViewEngineHost';
export { DEFAULT_ENGINE_HOST, getEngineHost, getEngineHostKinds, registerEngineHost } from './host/registry';

export {
  DropsServiceError,
  fetchNearbyDrops,
  verifyDropCollect,
  type CollectFix,
  type CollectVerifyRequest,
  type CollectVerifyResponse,
  type DropsServiceConfig,
  type FetchLike,
  type NearbyDropsQuery,
  type NearbyDropsResponse,
} from './service/drops';

export type {
  CharacterLayerProps,
  CharacterPosition,
  CharacterProps,
  DataDropLayerProps,
  DeviceLocationProvider,
  MapramaBuildingPressEvent,
  MapramaErrorEvent,
  MapramaLabelsProps,
  MapramaLocationProps,
  MapramaViewProps,
  MapramaViewRef,
  MapramaViewRefLike,
  MapramaPressEvent,
  MapramaReadyEvent,
  DropCollectInfo,
  DropCollectRejectedInfo,
  DropCollectVerifiedInfo,
  DropLayerBaseProps,
  DropLayerProps,
  EngineEventOf,
  FitBoundsOptions,
  GeofenceEventInfo,
  GeofenceProps,
  LabelContentFunction,
  MapOverlayAnchor,
  MapOverlayProps,
  MarkerIconInput,
  MarkerLayerProps,
  MarkerPressInfo,
  ModelInput,
  RequestOptions,
  ServiceDropLayerProps,
  SubscribeOptions,
  SubscriptionEventMap,
  TravelOptions,
  TravelResult,
} from './types';

export {
  CAMERA_FOV_DEG,
  CAMERA_IDLE_DELAY_MS,
  CAMERA_IDLE_HORIZON_FACTOR,
  CAMERA_IDLE_REASONS,
  visibleSpanMeters,
} from '@maprama/protocol';
export type {
  BuildingStyle,
  CameraIdleEvent,
  CameraIdleReason,
  CameraSpec,
  CameraState,
  CharacterSpec,
  ContentInset,
  DropSpec,
  EngineInfo,
  FitBoundsOrientation,
  FitBoundsPadding,
  FitBoundsParams,
  FitBoundsResult,
  LabelContent,
  LabelInfo,
  LngLat,
  LngLatBounds,
  LocationFix,
  LocationSourceKind,
  MapUiSpec,
  MarkerAnchor,
  MarkerIcon,
  MarkerShape,
  MarkerSpec,
  ScreenPoint,
  ThemeSpec,
  TravelMode,
  WorldSource,
} from '@maprama/protocol';
