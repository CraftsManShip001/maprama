/**
 * Internal scene API: the extension surface part-2 features (characters,
 * vehicles, travel, location, drops, geofences, traffic, labels, map UI)
 * build on. It is exposed as `EngineHandle.scene` and is **not** part of the
 * public protocol; it may change between versions.
 *
 * ## Extension points
 *
 * - **Scene graph**: add dynamic objects under `groups.dynamic` (its
 *   materials are converted automatically on theme changes). Static world
 *   groups are rebuilt on every theme/world change; do not add to them.
 * - **Materials**: create lit materials with `materials.make(color, extra)` so
 *   they follow the preset shading (toon/standard) and window-light rules.
 *   Objects outside `groups.dynamic` must call
 *   `materials.convertTree(root)` in an `onThemeChange` hook.
 * - **Frames**: `onFrame((dt, t) => …)` runs before the camera update and
 *   render every frame.
 * - **Camera**: `camera.follow(() => ({ x, z }), id)` to follow a character;
 *   `registerFollowResolver` lets `setCamera { follow: id }` find targets.
 * - **Silhouettes**: `silhouette.addSilhouette(mesh)` with
 *   `silhouette.createMaterial(color)` draws characters through buildings.
 * - **World**: `world()` (graph, POIs, stations, districts…), `snapToRoad`,
 *   `route`, `toWorld` / `toLngLat`, `groundAt`, `pickBuilding`.
 * - **DOM**: `overlayLayer` is a full-size layer above the canvas for labels
 *   and map UI (pointer events off by default).
 * - **Protocol**: `registerCommand` replaces the `unsupported` stub for a
 *   command; `registerRequest` a request method; `registerSubscription` a
 *   subscription topic; `emit` sends events to the host.
 *
 * @module
 */

import type {
  EngineEvent,
  EngineEventType,
  LabelsSpec,
  LngLat,
  LocationSourceKind,
  MapUiSpec,
  Projection,
  RequestMethod,
  SubscriptionTopic,
  WorldPoint,
} from '@diorama/protocol';
import type { Group, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';
import type { CommandHandler, RequestHandler } from './bridge/dispatcher.js';
import type { EventListener } from './bridge/emitter.js';
import type { CameraController, FollowTarget } from './core/camera.js';
import type { FrameHook, SilhouetteService } from './core/renderer.js';
import type { BuildingInfo } from './render/buildings.js';
import type { MaterialFactory } from './theme/materials.js';
import type { RenderParams } from './theme/params.js';
import type { TextureSet } from './theme/textures.js';
import type { SnapResult } from './world/graph.js';
import type { WorldModel } from './world/model.js';
import type { EngineCommandType } from '@diorama/protocol';

/** Handler for one subscription topic. */
export interface SubscriptionHandler {
  subscribe(id: string | undefined, throttleMs: number): void;
  unsubscribe(id: string | undefined): void;
}

export interface SceneApi {
  readonly three: {
    scene: Scene;
    /** Root of all world content. */
    root: Group;
    camera: PerspectiveCamera;
    renderer: WebGLRenderer;
  };
  readonly groups: {
    /** Ground, roads, water, props (rebuilt on theme / world change). */
    static: Group;
    /** Buildings (rebuilt on theme / world change). */
    buildings: Group;
    /** Map-colors overlay (zoom out). */
    mapOverlay: Group;
    /** Part-2 dynamic content (characters, vehicles, drops…). Kept across rebuilds. */
    dynamic: Group;
  };
  readonly materials: MaterialFactory;
  /** Procedural textures (created on first theme application). */
  textures(): TextureSet;
  readonly camera: CameraController;
  readonly silhouette: SilhouetteService;
  /** Full-size DOM layer above the canvas and mood overlays. */
  readonly overlayLayer: HTMLElement;
  readonly container: HTMLElement;
  readonly reduceMotion: boolean;
  /** Frames rendered so far. */
  frames(): number;

  params(): RenderParams;
  world(): WorldModel | null;
  projection(): Projection;
  toWorld(lngLat: LngLat): WorldPoint;
  toLngLat(point: WorldPoint): LngLat;
  ui(): MapUiSpec;
  labels(): LabelsSpec;
  locationSource(): LocationSourceKind;
  /** Current zoom-out factor 0..1 (see zoom-out behaviours). */
  zoomOutFactor(): number;

  onFrame(hook: FrameHook): () => void;
  /** Runs after the camera update, right before rendering (use for screen-space projection such as DOM labels). */
  onBeforeRender(hook: FrameHook): () => void;
  /** Called after a theme was applied and the static world rebuilt (before old materials are disposed). */
  onThemeChange(hook: (params: RenderParams) => void): () => void;
  /** Called after a world was loaded and rendered. Fires immediately when a world is already loaded. */
  onWorldLoad(hook: (world: WorldModel) => void): () => void;

  /** Ground point under CSS pixel coordinates (relative to the container). */
  groundAt(px: number, py: number): { x: number; z: number } | null;
  pickBuilding(px: number, py: number): { id: string; point: Vector3 } | null;
  building(id: string): BuildingInfo | null;
  snapToRoad(x: number, z: number): SnapResult | null;
  /** Road path between two world points. */
  route(from: WorldPoint, to: WorldPoint): WorldPoint[];

  registerCommand<T extends Exclude<EngineCommandType, 'request'>>(type: T, handler: CommandHandler<T>): () => void;
  registerRequest<M extends RequestMethod>(method: M, handler: RequestHandler<M>): () => void;
  registerSubscription(topic: SubscriptionTopic, handler: SubscriptionHandler): () => void;
  /** Resolves `setCamera { follow: id }` targets. */
  registerFollowResolver(resolver: (id: string) => FollowTarget | null): () => void;
  emit(event: EngineEvent): void;
  on<T extends EngineEventType>(type: T, cb: EventListener<T>): () => void;
}
