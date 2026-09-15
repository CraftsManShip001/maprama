/**
 * `@maprama/engine-web`: the three.js web render engine implementing the
 * `@maprama/protocol` message contract.
 *
 * ```ts
 * import { createEngine, createDirectTransport } from '@maprama/engine-web';
 * const transport = createDirectTransport();
 * transport.onEvent((event) => console.log(event));
 * const engine = createEngine(document.getElementById('map')!, { transport });
 * transport.postCommand({ type: 'init', world: { kind: 'procedural', layout: 'town' }, theme: { base: 'urban' }, labels: {}, ui: {}, locationSource: 'simulated' });
 * ```
 *
 * @packageDocumentation
 */

import { Engine, type EngineHandle, type EngineOptions } from './engine/engine.js';

/** Creates an engine rendering into `container` and listening on `options.transport`. */
export function createEngine(container: HTMLElement, options: EngineOptions): EngineHandle {
  return new Engine(container, options);
}

export type { EngineHandle, EngineOptions } from './engine/engine.js';
export { ENGINE_NAME, ENGINE_VERSION } from './version.js';

export { createDirectTransport, createWebViewTransport } from './bridge/transport.js';
export type { DirectTransport, Transport } from './bridge/transport.js';
export { Dispatcher, EngineError, NOT_IMPLEMENTED, UNSUPPORTED } from './bridge/dispatcher.js';
export type { CommandHandler, CommandOf, RequestHandler } from './bridge/dispatcher.js';
export { EventEmitter } from './bridge/emitter.js';

export type { SceneApi, SubscriptionHandler } from './scene-api.js';
export { CameraController, DIST_MAX, DIST_MIN, PITCH_MAX, PITCH_MIN } from './core/camera.js';
export type { CameraOrbit, FollowTarget } from './core/camera.js';
export { LAYER_DEFAULT, LAYER_OCCLUDER, LAYER_SILHOUETTE } from './core/renderer.js';
export type { FrameHook, SilhouetteService } from './core/renderer.js';
export { MaterialFactory } from './theme/materials.js';
export type { MatExtra } from './theme/materials.js';
export { LIGHT_SCALE, renderParamsFor } from './theme/params.js';
export type { RenderParams } from './theme/params.js';
export type { TextureSet, FacadeKey, FacadeTexture } from './theme/textures.js';

export { buildGraph, route, snap, ROAD_W, polylineLength } from './world/graph.js';
export type { GraphEdge, GraphNode, GraphRoad, RoadGraph, SnapResult } from './world/graph.js';
export { buildGridWorld } from './world/grid.js';
export { buildTownWorld, riverZ } from './world/town.js';
export { loadWorldData, resolveWorldSource, WorldLoadError } from './world/data.js';
export { PROCEDURAL_ORIGIN } from './world/model.js';
export type { BuildingModel, MassShape, RoofKind, WorldModel } from './world/model.js';
export { DEFAULT_KMH, planRoute, projectionFor } from './engine/requests.js';
export type { BuildingInfo } from './render/buildings.js';
