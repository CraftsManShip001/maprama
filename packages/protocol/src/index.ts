/**
 * `@maprama/protocol`: the shared contract between Maprama hosts (React Native,
 * tools, services) and render engines (web, native).
 *
 * - {@link createProjection}: `{ lng, lat }` ⇄ world units.
 * - {@link WorldData}: vector map data schema.
 * - {@link ThemeSpec} / {@link resolveTheme}: themes and built-in presets.
 * - {@link EngineCommand} / {@link EngineEvent}: the message protocol and codec.
 *
 * @packageDocumentation
 */

export type { ValidationResult } from './internal/validate.js';

export {
  DEFAULT_UNIT_METERS,
  EARTH_RADIUS_METERS,
  METERS_PER_DEGREE_LAT,
  METERS_PER_DEGREE_LNG,
  createProjection,
  haversineMeters,
} from './geo.js';
export type { LngLat, Projection, ProjectionOptions, WorldPoint } from './geo.js';

export {
  BUILDING_KINDS,
  POI_CATEGORIES,
  PROCEDURAL_LAYOUTS,
  ROAD_CLASSES,
  WORLD_DATA_VERSION,
  validateWorldData,
  validateWorldSource,
} from './world.js';
export type {
  BuildingFootprint,
  BuildingKind,
  District,
  Park,
  Poi,
  PoiCategory,
  Polygon,
  ProceduralLayout,
  Road,
  RoadClass,
  Station,
  Vec2,
  WorldBounds,
  WorldData,
  WorldSource,
} from './world.js';

export {
  BASE_THEME_DEFAULTS,
  FACADE_SETS,
  LANDMARK_GLASS_STYLES,
  MASSING_MODES,
  PRESET_NAMES,
  SHADING_MODELS,
  TIMES_OF_DAY,
  ZOOM_OUT_BEHAVIORS,
  resolveTheme,
  validateThemePreset,
  validateThemeSpec,
} from './theme.js';
export type {
  FacadeSet,
  LandmarkColors,
  LandmarkGlass,
  Massing,
  PresetDefaults,
  PresetName,
  ResolvedTheme,
  ShadingModel,
  ThemePreset,
  ThemeSpec,
  TimeOfDay,
  TimeOfDayPreset,
  ZoomOutBehavior,
} from './theme.js';

export { CINE, INK, PRESETS, PRESET_DEFAULTS, TIMES, minimal, modern, realistic, soft, toy, urban } from './presets/index.js';

export { HOLO_ICON_TILES, LABEL_CONTENT_MODES, LABEL_ICONS, LABEL_KINDS, LABEL_STYLES } from './labels.js';
export type {
  HoloIconTile,
  LabelContent,
  LabelContentMode,
  LabelIcon,
  LabelInfo,
  LabelKind,
  LabelStyle,
  LabelsSpec,
} from './labels.js';

export {
  ANIMATION_NAMES,
  BUILDING_DECORATIONS,
  DROP_TYPES,
  LOCATION_SOURCE_KINDS,
  RARITIES,
  ROOF_SHAPES,
  TRAVEL_MODES,
} from './entities.js';
export type {
  AnimationName,
  BuildingDecoration,
  BuildingStyle,
  CameraSpec,
  CharacterSpec,
  DropSpec,
  DropType,
  GeofenceSpec,
  JsonValue,
  LocationFix,
  LocationSourceKind,
  MapUiSpec,
  ModelSource,
  Rarity,
  RoofShape,
  TravelMode,
} from './entities.js';

export {
  ENGINE_COMMAND_TYPES,
  ENGINE_EVENT_TYPES,
  ENGINE_KINDS,
  PROTOCOL_VERSION,
  REQUEST_METHODS,
  SUBSCRIPTION_TOPICS,
  decodeCommand,
  decodeEvent,
  encodeCommand,
  encodeEvent,
  validateEngineCommand,
  validateEngineEvent,
} from './messages.js';
export type {
  BuildingPressEvent,
  CameraChangeEvent,
  CameraState,
  CancelTravelCommand,
  CharacterPositionEvent,
  CommandEnvelope,
  DecodeResult,
  DropCollectEvent,
  EngineCommand,
  EngineCommandType,
  EngineErrorCode,
  EngineEvent,
  EngineEventType,
  EngineInfo,
  EngineKind,
  Envelope,
  ErrorEvent,
  EventEnvelope,
  GeofenceEnterEvent,
  GeofenceExitEvent,
  InitCommand,
  LabelsIndexEvent,
  MapPressEvent,
  MessageKind,
  OverlayAnchor,
  OverlayPosition,
  OverlayPositionsEvent,
  ProtocolError,
  PushLocationCommand,
  ReadyEvent,
  RemoveCharactersCommand,
  RemoveDropLayerCommand,
  RequestCommand,
  RequestCommandOf,
  RequestMethod,
  RequestParamsMap,
  RequestResultMap,
  ResponseErrorEvent,
  ResponseEvent,
  ResponseOkEvent,
  RouteLeg,
  RouteResult,
  ScreenPoint,
  SetBuildingStyleCommand,
  SetCameraCommand,
  SetDropLayerCommand,
  SetGeofencesCommand,
  SetLabelContentCommand,
  SetLabelsCommand,
  SetLocationSourceCommand,
  SetOverlayAnchorsCommand,
  SetThemeCommand,
  SetUiCommand,
  SnapToRoadResult,
  SubscribeCommand,
  SubscriptionTopic,
  TravelArriveEvent,
  TravelCancelEvent,
  TravelCommand,
  TravelLeg,
  TravelProgressEvent,
  TravelStartEvent,
  UnsubscribeCommand,
  UpsertCharactersCommand,
} from './messages.js';
