/**
 * The map controller: implements {@link MapramaViewRef} on top of an
 * {@link EngineHost}. It owns the pre-ready command queue, request/response
 * correlation by `requestId`, the travel promise lifecycle, reference-counted
 * subscriptions and event fan-out.
 *
 * @module
 */

import type {
  BuildingStyle,
  CameraSpec,
  EngineCommand,
  EngineEvent,
  EngineEventType,
  EngineInfo,
  FitBoundsResult,
  FocusOnParams,
  FocusOnResult,
  InitCommand,
  LngLat,
  LngLatBounds,
  LocationFix,
  RequestCommand,
  RequestMethod,
  RequestParamsMap,
  RequestResultMap,
  SubscriptionTopic,
  TravelLeg,
  TravelMode,
} from '@maprama/protocol';
import { throttle } from './batching';
import { MapramaError, normalizeErrorCode, type MapramaErrorCode } from './errors';
import type { EngineHost } from './host/EngineHost';
import type {
  FitBoundsOptions,
  FocusOnOptions,
  FocusOnTarget,
  MapramaErrorEvent,
  MapramaViewRef,
  EngineEventOf,
  RequestOptions,
  SubscribeOptions,
  SubscriptionEventMap,
  TravelOptions,
  TravelResult,
} from './types';

/** Default timeout of request/response calls. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
/** Default time a travel may wait for `travel:start`. */
export const DEFAULT_TRAVEL_START_TIMEOUT_MS = 10000;
/** Default subscription throttle. */
export const DEFAULT_THROTTLE_MS = 250;

export interface MapControllerOptions {
  /** Builds the `init` command from the current props when the engine reports `ready`. */
  buildInit: () => InitCommand;
  /** Called after `init` and the queue were sent. `isReload` is true for every `ready` after the first. */
  onReady?: (engine: EngineInfo, isReload: boolean) => void;
  /** Receives engine `error` events (codes normalised) and host-side errors. */
  onError?: (error: MapramaErrorEvent) => void;
  /** Called before every imperative command so pending declarative changes go out first. */
  beforeImperativeSend?: () => void;
  /** Static default request timeout (used when `getTimeouts` returns none). */
  requestTimeoutMs?: number;
  /** Static default travel start timeout (used when `getTimeouts` returns none). */
  travelStartTimeoutMs?: number;
  /** Current timeout defaults (e.g. from the latest props); read every time a timer is armed. */
  getTimeouts?: () => { requestTimeoutMs?: number | undefined; travelStartTimeoutMs?: number | undefined };
  /** Current default travel `timeScale` (e.g. the `travelTimeScale` prop); read at every `travel` call. Default 1. */
  getTravelTimeScale?: () => number | undefined;
  /** Implements {@link MapramaViewRef.refreshLabelContent}. */
  refreshLabelContent?: () => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: MapramaError) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** Per-call `timeoutMs`; the map default is read when the timer is armed. */
  timeoutOverride: number | undefined;
  method: RequestMethod;
}

interface PendingTravel {
  characterId: string;
  legs: TravelLeg[];
  started: boolean;
  resolve: (value: TravelResult) => void;
  reject: (error: MapramaError) => void;
  startTimer: ReturnType<typeof setTimeout> | null;
  totalTimer: ReturnType<typeof setTimeout> | null;
  /** Per-call `startTimeoutMs`; the map default is read when the timer is armed. */
  startTimeoutOverride: number | undefined;
  timeoutMs: number | undefined;
}

interface SubscriptionListener {
  throttleMs: number;
  deliver: { call: (event: EngineEvent) => void; cancel: () => void };
}

interface SubscriptionEntry {
  topic: SubscriptionTopic;
  id: string | undefined;
  listeners: Set<SubscriptionListener>;
  /** Throttle last sent to the engine. */
  sentThrottleMs: number;
  offEvent: () => void;
}

type AnyListener = (event: EngineEvent) => void;

let idCounter = 0;
const nextId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Implementation of {@link MapramaViewRef}. */
export class MapController implements MapramaViewRef {
  private host: EngineHost | null = null;
  private offHost: (() => void) | null = null;
  private initialized = false;
  private everReady = false;
  private disposed = false;
  private engineInfo: EngineInfo | null = null;
  private lastFix: LocationFix | null = null;
  private queue: EngineCommand[] = [];
  private readonly listeners = new Map<string, Set<AnyListener>>();
  private readonly requests = new Map<string, PendingRequest>();
  private readonly travels = new Map<string, PendingTravel>();
  private readonly subscriptions = new Map<string, SubscriptionEntry>();

  constructor(private readonly options: MapControllerOptions) {}

  // -- host wiring -----------------------------------------------------------

  /** Connects a host (replacing the previous one). The engine must report `ready` before `init` is sent. */
  attachHost(host: EngineHost): void {
    this.detachHost();
    this.host = host;
    this.offHost = host.onEvent((event) => this.handleEvent(event));
  }

  /** Disconnects the current host. Commands are queued until the next host is ready. */
  detachHost(): void {
    this.offHost?.();
    this.offHost = null;
    this.host = null;
    this.initialized = false;
  }

  /** Rejects pending operations and stops accepting commands. */
  dispose(): void {
    if (this.disposed) return;
    this.rejectPending('unmounted', 'the map was unmounted');
    for (const entry of this.subscriptions.values()) {
      entry.offEvent();
      for (const l of entry.listeners) l.deliver.cancel();
    }
    this.subscriptions.clear();
    this.detachHost();
    this.listeners.clear();
    this.queue = [];
    this.disposed = true;
  }

  /** Sends a command now when initialised, otherwise queues it (flushed in order after `init`). */
  sendCommand(command: EngineCommand): void {
    if (this.disposed) return;
    if (this.initialized && this.host) this.host.send(command);
    else this.queue.push(command);
  }

  /** Sends an imperative command after flushing pending declarative changes. */
  send(command: EngineCommand): void {
    if (this.disposed) return;
    this.options.beforeImperativeSend?.();
    this.sendCommand(command);
  }

  /** Latest fix passed to {@link pushLocation}, if any. */
  getLastFix(): LocationFix | null {
    return this.lastFix;
  }

  /** Reports a host-side error through `onError`. */
  reportError(error: MapramaErrorEvent): void {
    this.options.onError?.(error);
  }

  /**
   * Reports an engine host failure through `onError`. A fatal failure (e.g.
   * `host_load_failed`, or no host registered) also rejects every pending
   * request and travel with a {@link MapramaError} carrying the host's code,
   * because the engine will not answer them.
   */
  reportHostError(error: MapramaErrorEvent): void {
    if (error.fatal && !this.disposed) this.rejectPending(error.code, error.message);
    this.options.onError?.(error);
  }

  /** Routes one decoded engine event. Never throws. */
  handleEvent(event: EngineEvent): void {
    if (this.disposed) return;
    switch (event.type) {
      case 'ready':
        this.onEngineReady(event.engine);
        break;
      case 'error':
        this.options.onError?.({ code: normalizeErrorCode(event.code), message: event.message, fatal: event.fatal });
        break;
      case 'response': {
        const pending = this.requests.get(event.requestId);
        if (!pending) break;
        this.requests.delete(event.requestId);
        if (pending.timer) clearTimeout(pending.timer);
        if (event.ok) pending.resolve(event.result);
        else pending.reject(new MapramaError(normalizeErrorCode(event.error.code), event.error.message));
        break;
      }
      case 'travel:start': {
        const travel = this.travels.get(event.requestId);
        if (!travel) break;
        travel.started = true;
        travel.legs = event.legs;
        if (travel.startTimer) clearTimeout(travel.startTimer);
        travel.startTimer = null;
        break;
      }
      case 'travel:arrive': {
        const travel = this.takeTravel(event.requestId);
        travel?.resolve({ requestId: event.requestId, characterId: event.characterId, legs: travel.legs });
        break;
      }
      case 'travel:cancel': {
        const travel = this.takeTravel(event.requestId);
        travel?.reject(new MapramaError('travel_cancelled', `travel ${event.requestId} of "${event.characterId}" was cancelled`));
        break;
      }
      default:
        break;
    }
    this.emit(event);
  }

  private onEngineReady(engine: EngineInfo): void {
    const isReload = this.everReady;
    this.engineInfo = engine;
    if (!this.host) return;
    if (isReload) {
      // The engine lost its state: pending operations cannot complete.
      this.rejectPending('engine_reloaded', 'the engine reloaded');
    }
    let init: InitCommand;
    try {
      init = this.options.buildInit();
    } catch (e) {
      this.options.onError?.({ code: 'internal', message: `failed to build init: ${errorMessage(e)}`, fatal: true });
      return;
    }
    this.host.send(init);
    this.initialized = true;
    this.everReady = true;
    const queued = this.queue;
    this.queue = [];
    if (isReload) {
      for (const entry of this.subscriptions.values()) {
        this.host.send({ type: 'subscribe', topic: entry.topic, ...(entry.id !== undefined ? { id: entry.id } : {}), throttleMs: entry.sentThrottleMs });
      }
    }
    for (const command of queued) this.host.send(command);
    // Timeouts count from the moment the command actually reached the engine.
    for (const [requestId, pending] of this.requests) this.armRequestTimer(requestId, pending);
    for (const [requestId, travel] of this.travels) this.armTravelTimers(requestId, travel);
    this.options.onReady?.(engine, isReload);
  }

  // -- events ----------------------------------------------------------------

  addEventListener<T extends EngineEventType>(type: T, listener: (event: EngineEventOf<T>) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    const fn = listener as AnyListener;
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  private emit(event: EngineEvent): void {
    const set = this.listeners.get(event.type);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch (e) {
        this.options.onError?.({ code: 'listener_error', message: `${event.type} listener threw: ${errorMessage(e)}`, fatal: false });
      }
    }
  }

  // -- imperative API --------------------------------------------------------

  getEngineInfo(): EngineInfo | null {
    return this.engineInfo;
  }

  isReady(): boolean {
    return this.initialized;
  }

  refreshLabelContent(): void {
    if (this.disposed) return;
    this.options.refreshLabelContent?.();
  }

  setCamera(camera: CameraSpec): void {
    this.send({ type: 'setCamera', camera });
  }

  pushLocation(fix: LocationFix): void {
    this.lastFix = fix;
    if (!this.initialized) {
      // Before ready only the newest fix matters.
      this.queue = this.queue.filter((c) => c.type !== 'pushLocation');
    }
    this.send({ type: 'pushLocation', fix });
  }

  setBuildingStyle(buildingId: string, style: BuildingStyle | null): void {
    this.send({ type: 'setBuildingStyle', buildingId, style });
  }

  cancelTravel(characterId: string): void {
    this.send({ type: 'cancelTravel', characterId });
  }

  travel(characterId: string, to: LngLat, modes: TravelMode | TravelMode[] = ['walk'], options: TravelOptions = {}): Promise<TravelResult> {
    if (this.disposed) return Promise.reject(new MapramaError('unmounted', 'the map was unmounted'));
    const perCall = options.timeScale !== undefined;
    const timeScale: unknown = perCall ? options.timeScale : (this.options.getTravelTimeScale?.() ?? 1);
    if (!(typeof timeScale === 'number' && Number.isFinite(timeScale) && timeScale > 0)) {
      const source = perCall ? 'options.timeScale' : 'travelTimeScale';
      return Promise.reject(new MapramaError('invalid_argument', `travel: ${source} must be a finite number > 0, got ${String(timeScale)}`));
    }
    const requestId = nextId('travel');
    const modeList = Array.isArray(modes) ? modes : [modes];
    return new Promise<TravelResult>((resolve, reject) => {
      const travel: PendingTravel = {
        characterId,
        legs: [],
        started: false,
        resolve,
        reject,
        startTimer: null,
        totalTimer: null,
        startTimeoutOverride: options.startTimeoutMs,
        timeoutMs: options.timeoutMs,
      };
      this.travels.set(requestId, travel);
      // Real-world speed (1) keeps the command shape of engines that predate `timeScale`.
      this.send(timeScale === 1 ? { type: 'travel', requestId, characterId, to, modes: modeList } : { type: 'travel', requestId, characterId, to, modes: modeList, timeScale });
      // Before ready this bounds the wait for the engine; `ready` re-arms the timers from delivery.
      this.armTravelTimers(requestId, travel);
    });
  }

  request<M extends RequestMethod>(method: M, params: RequestParamsMap[M], options: RequestOptions = {}): Promise<RequestResultMap[M]> {
    if (this.disposed) return Promise.reject(new MapramaError('unmounted', 'the map was unmounted'));
    const requestId = nextId('req');
    return new Promise<RequestResultMap[M]>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: null,
        timeoutOverride: options.timeoutMs,
        method,
      };
      this.requests.set(requestId, pending);
      this.send({ type: 'request', requestId, method, params } as RequestCommand);
      // Before ready this bounds the wait for the engine; `ready` re-arms the timer from delivery.
      this.armRequestTimer(requestId, pending);
    });
  }

  project(coordinate: LngLat, options?: RequestOptions) {
    return this.request('project', { coordinate }, options);
  }

  async unproject(point: { x: number; y: number }, options?: RequestOptions): Promise<LngLat | null> {
    const result = await this.request('unproject', { x: point.x, y: point.y }, options);
    return result.coordinate;
  }

  snapToRoad(coordinate: LngLat, maxDistanceMeters?: number, options?: RequestOptions) {
    return this.request('snapToRoad', maxDistanceMeters === undefined ? { coordinate } : { coordinate, maxDistanceMeters }, options);
  }

  snapToBuilding(coordinate: LngLat, maxDistanceMeters?: number, options?: RequestOptions) {
    return this.request('snapToBuilding', maxDistanceMeters === undefined ? { coordinate } : { coordinate, maxDistanceMeters }, options);
  }

  route(from: LngLat, to: LngLat, modes: TravelMode[] = ['walk'], options?: RequestOptions) {
    return this.request('route', { from, to, modes }, options);
  }

  fitBounds(bounds: LngLatBounds, options: FitBoundsOptions = {}): Promise<FitBoundsResult> {
    const { timeoutMs, ...params } = options;
    return this.request('fitBounds', { ...params, bounds }, timeoutMs === undefined ? {} : { timeoutMs });
  }

  focusOn(target: FocusOnTarget, options: FocusOnOptions = {}): Promise<FocusOnResult> {
    const { timeoutMs, ...rest } = options;
    const where: Pick<FocusOnParams, 'coordinate' | 'infoCardId'> =
      'infoCardId' in target ? { infoCardId: target.infoCardId } : { coordinate: { lng: target.lng, lat: target.lat } };
    return this.request('focusOn', { ...rest, ...where }, timeoutMs === undefined ? {} : { timeoutMs });
  }

  subscribe<T extends SubscriptionTopic>(
    topic: T,
    listener: (event: SubscriptionEventMap[T]) => void,
    options: SubscribeOptions = {},
  ): () => void {
    if (this.disposed) return () => {};
    const id = options.id;
    const throttleMs = Math.max(0, options.throttleMs ?? DEFAULT_THROTTLE_MS);
    const key = `${topic}|${id ?? '*'}`;
    let entry = this.subscriptions.get(key);
    if (!entry) {
      const created: SubscriptionEntry = {
        topic,
        id,
        listeners: new Set(),
        sentThrottleMs: Number.NaN,
        offEvent: () => {},
      };
      created.offEvent = this.addEventListener(topic, (event: EngineEvent) => {
        if (id !== undefined && subscriptionTargetId(event) !== id) return;
        for (const l of [...created.listeners]) l.deliver.call(event);
      });
      this.subscriptions.set(key, created);
      entry = created;
    }
    const sub: SubscriptionListener = {
      throttleMs,
      deliver: throttle((event: EngineEvent) => {
        try {
          listener(event as SubscriptionEventMap[T]);
        } catch (e) {
          this.options.onError?.({ code: 'listener_error', message: `${topic} subscriber threw: ${errorMessage(e)}`, fatal: false });
        }
      }, throttleMs),
    };
    entry.listeners.add(sub);
    this.syncSubscription(entry);

    const owner = entry;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      sub.deliver.cancel();
      owner.listeners.delete(sub);
      if (this.subscriptions.get(key) !== owner) return;
      if (owner.listeners.size === 0) {
        owner.offEvent();
        this.subscriptions.delete(key);
        this.sendCommand({ type: 'unsubscribe', topic, ...(id !== undefined ? { id } : {}) });
      } else {
        this.syncSubscription(owner);
      }
    };
  }

  // -- internals -------------------------------------------------------------

  private syncSubscription(entry: SubscriptionEntry): void {
    let min = Infinity;
    for (const l of entry.listeners) min = Math.min(min, l.throttleMs);
    if (min === entry.sentThrottleMs) return;
    entry.sentThrottleMs = min;
    this.sendCommand({
      type: 'subscribe',
      topic: entry.topic,
      ...(entry.id !== undefined ? { id: entry.id } : {}),
      throttleMs: min,
    });
  }

  /** Map-wide timeout defaults, read from the latest options at the moment a timer is armed. */
  private currentTimeouts(): { requestTimeoutMs: number; travelStartTimeoutMs: number } {
    const latest = this.options.getTimeouts?.();
    return {
      requestTimeoutMs: latest?.requestTimeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      travelStartTimeoutMs: latest?.travelStartTimeoutMs ?? this.options.travelStartTimeoutMs ?? DEFAULT_TRAVEL_START_TIMEOUT_MS,
    };
  }

  /** Removes a request/travel command that is still waiting in the pre-ready queue. */
  private dropQueued(type: 'request' | 'travel', requestId: string): void {
    this.queue = this.queue.filter((c) => !(c.type === type && (c as { requestId?: string }).requestId === requestId));
  }

  private armRequestTimer(requestId: string, pending: PendingRequest): void {
    if (pending.timer) clearTimeout(pending.timer);
    const timeoutMs = pending.timeoutOverride ?? this.currentTimeouts().requestTimeoutMs;
    const delivered = this.initialized;
    pending.timer = setTimeout(() => {
      if (this.requests.get(requestId) !== pending) return;
      this.requests.delete(requestId);
      if (!delivered) this.dropQueued('request', requestId);
      pending.reject(
        new MapramaError(
          'timeout',
          delivered
            ? `request "${pending.method}" timed out after ${timeoutMs} ms`
            : `request "${pending.method}": the engine was not ready within ${timeoutMs} ms`,
        ),
      );
    }, timeoutMs);
  }

  private armTravelTimers(requestId: string, travel: PendingTravel): void {
    const delivered = this.initialized;
    const fail = (message: string): void => {
      if (this.travels.get(requestId) !== travel) return;
      this.takeTravel(requestId);
      travel.reject(new MapramaError('timeout', message));
      if (delivered) this.sendCommand({ type: 'cancelTravel', characterId: travel.characterId });
      else this.dropQueued('travel', requestId);
    };
    const startTimeoutMs = travel.startTimeoutOverride ?? this.currentTimeouts().travelStartTimeoutMs;
    if (!travel.started) {
      if (travel.startTimer) clearTimeout(travel.startTimer);
      travel.startTimer = setTimeout(
        () =>
          fail(
            delivered
              ? `travel ${requestId} did not start within ${startTimeoutMs} ms`
              : `travel ${requestId}: the engine was not ready within ${startTimeoutMs} ms`,
          ),
        startTimeoutMs,
      );
    }
    if (delivered && travel.timeoutMs !== undefined) {
      if (travel.totalTimer) clearTimeout(travel.totalTimer);
      travel.totalTimer = setTimeout(
        () => fail(`travel ${requestId} did not arrive within ${travel.timeoutMs} ms`),
        travel.timeoutMs,
      );
    }
  }

  private takeTravel(requestId: string): PendingTravel | undefined {
    const travel = this.travels.get(requestId);
    if (!travel) return undefined;
    this.travels.delete(requestId);
    if (travel.startTimer) clearTimeout(travel.startTimer);
    if (travel.totalTimer) clearTimeout(travel.totalTimer);
    return travel;
  }

  private rejectPending(code: MapramaErrorCode, message: string): void {
    // Rejected work must not reach an engine that becomes ready later.
    this.queue = this.queue.filter((c) => c.type !== 'request' && c.type !== 'travel');
    for (const [requestId, pending] of [...this.requests]) {
      this.requests.delete(requestId);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new MapramaError(code, `request "${pending.method}": ${message}`));
    }
    for (const requestId of [...this.travels.keys()]) {
      const travel = this.takeTravel(requestId);
      travel?.reject(new MapramaError(code, `travel ${requestId}: ${message}`));
    }
  }
}

function subscriptionTargetId(event: EngineEvent): string | undefined {
  if (event.type === 'character:position') return event.id;
  if (event.type === 'travel:progress') return event.characterId;
  return undefined;
}
