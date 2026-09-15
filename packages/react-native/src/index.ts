/**
 * `@diorama/react-native`: a 2.5D game map for React Native.
 *
 * - {@link DioramaMap} with {@link Character}, {@link CharacterLayer}, {@link DropLayer},
 *   {@link Geofence} and {@link MapOverlay} children.
 * - Imperative API via `ref` ({@link DioramaMapRef}) or {@link useDioramaMap}.
 * - Opt-in continuous values with {@link useCharacterPosition} and {@link useCameraState}.
 * - Swappable engine hosts via {@link registerEngineHost}.
 *
 * @packageDocumentation
 */

export { DioramaMap } from './DioramaMap';
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

export { useDioramaMap } from './hooks/useDioramaMap';
export { useCharacterPosition, type UseCharacterPositionOptions } from './hooks/useCharacterPosition';
export { useCameraState, type UseCameraStateOptions } from './hooks/useCameraState';

export { DioramaError, normalizeErrorCode, type DioramaErrorCode, type HostErrorCode } from './errors';
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
  DioramaBuildingPressEvent,
  DioramaErrorEvent,
  DioramaLabelsProps,
  DioramaLocationProps,
  DioramaMapProps,
  DioramaMapRef,
  DioramaMapRefLike,
  DioramaPressEvent,
  DioramaReadyEvent,
  DropCollectInfo,
  DropCollectRejectedInfo,
  DropCollectVerifiedInfo,
  DropLayerBaseProps,
  DropLayerProps,
  EngineEventOf,
  GeofenceEventInfo,
  GeofenceProps,
  LabelContentFunction,
  MapOverlayAnchor,
  MapOverlayProps,
  ModelInput,
  RequestOptions,
  ServiceDropLayerProps,
  SubscribeOptions,
  SubscriptionEventMap,
  TravelOptions,
  TravelResult,
} from './types';

export type {
  BuildingStyle,
  CameraSpec,
  CameraState,
  CharacterSpec,
  DropSpec,
  EngineInfo,
  LabelContent,
  LabelInfo,
  LngLat,
  LocationFix,
  LocationSourceKind,
  MapUiSpec,
  ScreenPoint,
  ThemeSpec,
  TravelMode,
  WorldSource,
} from '@diorama/protocol';
