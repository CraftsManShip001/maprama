/**
 * @module
 */

import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { haversineMeters, type DropSpec, type JsonValue, type LngLat } from '@diorama/protocol';
import { useMapContext } from '../context';
import { useCharacterPosition } from '../hooks/useCharacterPosition';
import { resolveModel } from '../model';
import type { DropLayerState } from '../batching';
import { DropsServiceError, fetchNearbyDrops, verifyDropCollect, type NearbyDropsResponse } from '../service/drops';
import type { DataDropLayerProps, DropCollectInfo, DropLayerProps, ServiceDropLayerProps } from '../types';

/** Default collect radius in meters. */
export const DEFAULT_COLLECT_RADIUS_METERS = 15;
/** Default distance the player moves before service drops are refetched. */
export const DEFAULT_REFETCH_DISTANCE_METERS = 150;
/** Default throttle of the position subscription driving `source="service"` fetches. */
export const DEFAULT_POSITION_THROTTLE_MS = 1000;
/** Delays before retrying a failed nearby fetch; the last delay repeats. */
export const DROPS_FETCH_RETRY_DELAYS_MS: readonly number[] = [2000, 5000, 15000];
/** Lower bound for a retry delay requested by `Retry-After`. */
export const MIN_RETRY_AFTER_MS = 2000;
/** Upper bound for a server-requested `Retry-After` delay. */
export const MAX_RETRY_AFTER_MS = 5 * 60 * 1000;

/** Nearby-fetch error codes that are never retried (the request cannot succeed until the config changes). */
const PERMANENT_FETCH_CODES = new Set([
  'INVALID_KEY',
  'MISSING_KEY',
  'MALFORMED_AUTHORIZATION',
  'FORBIDDEN_ROLE',
  'QUERY_KEY_NOT_ALLOWED',
  'BAD_REQUEST',
]);

/**
 * @internal Whether a failed nearby fetch is retried. Retried: network errors,
 * `INVALID_RESPONSE`, HTTP 408, 429 and 5xx. Not retried: the auth / request
 * codes `INVALID_KEY`, `MISSING_KEY`, `MALFORMED_AUTHORIZATION`,
 * `FORBIDDEN_ROLE`, `QUERY_KEY_NOT_ALLOWED`, `BAD_REQUEST` and `INVALID_*`
 * (except `INVALID_RESPONSE`), and every other HTTP 4xx (400, 401, 403, 404, …).
 */
export function isRetryableFetchError(error: unknown): boolean {
  if (!(error instanceof DropsServiceError)) return true; // unexpected throw: treat like a network error
  const { code, status } = error;
  if (code === 'NETWORK_ERROR' || code === 'INVALID_RESPONSE') return true;
  if (PERMANENT_FETCH_CODES.has(code) || code.startsWith('INVALID_')) return false;
  if (status === 408 || status === 429 || status >= 500 || status === 0) return true;
  return !(status >= 400 && status < 500);
}

/** Rejection codes after which the drop is shown again (the collection may succeed later). */
const RESTORE_CODES = new Set(['TOO_FAR', 'TELEPORT', 'STALE_FIX', 'QUOTA_EXCEEDED', 'NETWORK_ERROR', 'INVALID_RESPONSE']);
/** Rejection codes after which the drop stays hidden (it cannot be collected again). */
const FINAL_CODES = new Set(['ALREADY_COLLECTED', 'DROP_EXPIRED', 'DROP_NOT_FOUND', 'COLLECT_ID_CONFLICT']);

/**
 * Whether a drop hidden on `drop:collect` reappears after the service rejected
 * the collection: yes for `TOO_FAR`, `TELEPORT`, `STALE_FIX`, `QUOTA_EXCEEDED`,
 * `NETWORK_ERROR`, `INVALID_RESPONSE` and HTTP 5xx; no for `ALREADY_COLLECTED`,
 * `DROP_EXPIRED`, `DROP_NOT_FOUND`, `COLLECT_ID_CONFLICT` and any other code.
 */
export function shouldRestoreRejectedDrop(code: string, status: number): boolean {
  if (FINAL_CODES.has(code)) return false;
  return RESTORE_CODES.has(code) || /^HTTP_5\d\d$/.test(code) || status >= 500;
}

/**
 * A layer of collectible drops, fed from app `data` or from the hosted service
 * (`source="service"`). Changes send one `setDropLayer` per frame; unmounting
 * sends `removeDropLayer`.
 *
 * ```tsx
 * <DropLayer id="music" data={tracks} getId={t => t.id} getCoordinate={t => t.coord} getType={() => 'cd'}
 *   getRarity={t => t.rarity} getPayload={t => ({ trackId: t.id })} collectRadiusMeters={15} onCollect={e => verifyOnServer(e)} />
 * <DropLayer id="coins" source="service" channel="coins" apiKey={key} baseUrl="https://api.example" userId={uid}
 *   onCollectVerified={e => grant(e.receipt)} onCollectRejected={e => warn(e.code)} />
 * ```
 */
export function DropLayer<T>(props: DropLayerProps<T>) {
  return props.source === 'service' ? <ServiceDropLayer {...props} /> : <DataDropLayer {...(props as DataDropLayerProps<T>)} />;
}

/** Registers the layer and routes `drop:collect` events of this layer. */
function useDropLayer(
  id: string,
  drops: DropSpec[],
  collectRadiusMeters: number,
  collectorIds: string[] | undefined,
  onCollect: (info: DropCollectInfo) => void,
): { hideNow: (dropId: string) => void } {
  const { batcher, controller } = useMapContext('DropLayer');
  const payloads = useRef(new Map<string, JsonValue | undefined>());
  const handler = useRef(onCollect);
  handler.current = onCollect;
  const registered = useRef<DropLayerState | null>(null);

  useEffect(() => {
    // Keep payloads of hidden (collected) drops so late events still carry them.
    for (const d of drops) payloads.current.set(d.id, d.payload);
    const state: DropLayerState = { drops, collectRadiusMeters, ...(collectorIds ? { collectorIds } : {}) };
    registered.current = state;
    batcher.setDropLayer(id, state);
  });

  useEffect(() => () => batcher.removeDropLayer(id), [batcher, id]);

  useEffect(
    () =>
      controller.addEventListener('drop:collect', (e) => {
        if (e.layerId !== id) return;
        handler.current({
          layerId: e.layerId,
          dropId: e.dropId,
          characterId: e.characterId,
          coordinate: e.coordinate,
          collectId: e.collectId,
          payload: payloads.current.get(e.dropId),
        });
      }),
    [controller, id],
  );

  return {
    /**
     * Sends the layer without `dropId` right away (not on the next frame), so the
     * engine's layer state reflects the hidden drop before a verification result
     * can restore it; otherwise hide + restore within one frame would cancel out.
     */
    hideNow: (dropId) => {
      const state = registered.current;
      if (!state) return;
      batcher.setDropLayer(id, { ...state, drops: state.drops.filter((d) => d.id !== dropId) });
      batcher.flushNow();
    },
  };
}

function DataDropLayer<T>(props: DataDropLayerProps<T>): null {
  const drops = props.data.map((item): DropSpec => {
    const coordinate = props.getCoordinate(item);
    const drop: DropSpec = {
      id: props.getId(item),
      type: props.getType?.(item) ?? 'coin',
      coordinate: { lng: coordinate.lng, lat: coordinate.lat },
    };
    const rarity = props.getRarity?.(item);
    if (rarity !== undefined) drop.rarity = rarity;
    const value = props.getValue?.(item);
    if (value !== undefined) drop.value = value;
    const model = resolveModel(props.getModel?.(item));
    if (model) drop.model = model;
    const payload = props.getPayload?.(item);
    if (payload !== undefined) drop.payload = payload;
    return drop;
  });
  useDropLayer(props.id, drops, props.collectRadiusMeters ?? DEFAULT_COLLECT_RADIUS_METERS, props.collectorIds, (info) =>
    props.onCollect?.(info),
  );
  return null;
}

interface NearbyTrackerCallbacks {
  /** Performs one nearby fetch around `center` with the current config. */
  fetch: (center: LngLat) => Promise<NearbyDropsResponse>;
  /** Receives the drops of the newest applied response. */
  onDrops: (drops: DropSpec[]) => void;
  /**
   * A fetch failed. `retryInMs` is the delay before the next attempt, or `null`
   * when the error is permanent and fetching stopped until the config changes.
   */
  onError: (error: unknown, retryInMs: number | null) => void;
}

/**
 * @internal Nearby-drops fetch state for `source="service"`. It lives outside
 * the per-position effect, so position updates never cancel an in-flight
 * request, the window-expiry timer or a pending retry. Only {@link stop}
 * (unmount or config change) discards them.
 *
 * - A fetch starts when there is no previous attempt, the position moved more
 *   than the refetch distance from the last attempt, or the window expired.
 * - Starting a fetch clears the known window (`expiresAt`); only a successful
 *   response sets it again, so a failed refetch never makes later positions
 *   count as expired.
 * - Responses carry a sequence number; a response older than the one already
 *   applied is ignored, but an older response is still applied while no newer
 *   one has arrived.
 * - Failures of the newest request are reported. Retryable ones
 *   ({@link isRetryableFetchError}) are retried at the latest position after
 *   {@link DROPS_FETCH_RETRY_DELAYS_MS} (or `Retry-After`, at least
 *   {@link MIN_RETRY_AFTER_MS}); permanent ones stop fetching until `stop` +
 *   `start`. Failures of superseded requests are ignored.
 * - While a retry is pending, position updates neither fetch nor clear the
 *   retry, except a move of more than the refetch distance from both the last
 *   attempt and the last successful fetch: that fetches once right away and
 *   keeps the backoff step. Only a success resets the backoff.
 */
export class NearbyDropsTracker {
  private generation = 0;
  private seq = 0;
  private appliedSeq = 0;
  private inFlightSeq = 0;
  /** Center of the last attempt. */
  private anchor: LngLat | null = null;
  /** Center of the last applied (successful) response. */
  private successCenter: LngLat | null = null;
  private latest: LngLat | null = null;
  private expiresAt: number | null = null;
  private windowTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private running = false;
  /** A permanent error stopped fetching until the next `start`. */
  private halted = false;

  constructor(private readonly callbacks: NearbyTrackerCallbacks) {}

  /** Starts (or restarts after `stop`) and fetches right away when a position is known. */
  start(): void {
    this.running = true;
    this.halted = false;
    if (this.latest) this.fetchAt(this.latest);
  }

  /** Discards in-flight results, timers, fetch history and the backoff. The last position is kept for `start`. */
  stop(): void {
    this.running = false;
    this.halted = false;
    this.generation += 1;
    this.clearWindowTimer();
    this.clearRetryTimer();
    this.appliedSeq = 0;
    this.inFlightSeq = 0;
    this.anchor = null;
    this.successCenter = null;
    this.expiresAt = null;
    this.failures = 0;
  }

  /** Feeds the tracked character's position. */
  updatePosition(center: LngLat, refetchDistanceMeters: number): void {
    this.latest = center;
    if (!this.running || this.halted) return;
    const far = (from: LngLat | null): boolean => from === null || haversineMeters(from, center) > refetchDistanceMeters;
    if (this.retryTimer) {
      // Backing off: only a real area change fetches early, once, keeping the backoff step.
      if (this.anchor && far(this.anchor) && far(this.successCenter)) this.fetchAt(center);
      return;
    }
    const expired = this.expiresAt !== null && Date.now() >= this.expiresAt && this.inFlightSeq === 0;
    // An in-flight request or the window timer already covers this position.
    if (this.anchor && !expired && !far(this.anchor)) return;
    this.fetchAt(center);
  }

  private fetchAt(center: LngLat): void {
    this.clearRetryTimer();
    this.clearWindowTimer();
    this.expiresAt = null;
    const generation = this.generation;
    const seq = ++this.seq;
    this.inFlightSeq = seq;
    this.anchor = center;
    let request: Promise<NearbyDropsResponse>;
    try {
      request = this.callbacks.fetch(center);
    } catch (e) {
      request = Promise.reject(e);
    }
    request.then(
      (result) => {
        if (generation !== this.generation) return;
        if (this.inFlightSeq === seq) this.inFlightSeq = 0;
        if (seq < this.appliedSeq) return; // a newer response is already applied
        this.appliedSeq = seq;
        this.successCenter = center;
        if (seq === this.seq) this.failures = 0;
        this.clearWindowTimer();
        // A newer request is failing and backing off: keep the drops, but leave refetching to the retry.
        // Guard against clock skew: an already-past window must not cause a tight refetch loop.
        this.expiresAt = this.retryTimer || result.expiresAt === null ? null : Math.max(result.expiresAt, Date.now() + MIN_RETRY_AFTER_MS);
        if (this.expiresAt !== null) {
          this.windowTimer = setTimeout(
            () => {
              this.windowTimer = null;
              if (this.running && !this.halted && !this.retryTimer && this.latest) this.fetchAt(this.latest);
            },
            Math.max(0, this.expiresAt - Date.now()) + 50,
          );
        }
        this.callbacks.onDrops(result.drops);
      },
      (error: unknown) => {
        if (generation !== this.generation) return;
        if (this.inFlightSeq !== seq) return; // superseded by a newer request
        this.inFlightSeq = 0;
        this.clearWindowTimer();
        this.expiresAt = null;
        if (!isRetryableFetchError(error)) {
          this.halted = true;
          this.callbacks.onError(error, null);
          return;
        }
        const delays = DROPS_FETCH_RETRY_DELAYS_MS;
        const scheduled = delays[Math.min(this.failures, delays.length - 1)] ?? 15000;
        const retryAfter = error instanceof DropsServiceError ? error.retryAfterMs : undefined;
        const retryInMs = retryAfter !== undefined ? Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, retryAfter)) : scheduled;
        this.failures += 1;
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          if (this.running && !this.halted && this.latest) this.fetchAt(this.latest);
        }, retryInMs);
        this.callbacks.onError(error, retryInMs);
      },
    );
  }

  private clearWindowTimer(): void {
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.windowTimer = null;
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}

function ServiceDropLayer(props: ServiceDropLayerProps): null {
  const { batcher, controller } = useMapContext('DropLayer');
  const { channel, apiKey, baseUrl, radiusMeters, userId } = props;
  const refetchDistance = props.refetchDistanceMeters ?? DEFAULT_REFETCH_DISTANCE_METERS;
  const playerId = useSyncExternalStore(batcher.subscribePlayer, batcher.getPlayerId, batcher.getPlayerId);
  const trackedId = props.characterId ?? props.collectorIds?.[0] ?? playerId;
  const position = useCharacterPosition(controller, trackedId, {
    throttleMs: props.positionThrottleMs ?? DEFAULT_POSITION_THROTTLE_MS,
  });

  const [drops, setDrops] = useState<DropSpec[]>([]);
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  const collected = useRef(new Set<string>());
  const latest = useRef(props);
  latest.current = props;

  const [tracker] = useState(
    () =>
      new NearbyDropsTracker({
        fetch: (center) => {
          const p = latest.current;
          return fetchNearbyDrops(
            { baseUrl: p.baseUrl, apiKey: p.apiKey },
            { lng: center.lng, lat: center.lat, channel: p.channel, ...(p.radiusMeters !== undefined ? { radiusMeters: p.radiusMeters } : {}) },
          );
        },
        onDrops: setDrops,
        onError: (e, retryInMs) => {
          const code = e instanceof DropsServiceError ? e.code : 'NETWORK_ERROR';
          const next = retryInMs === null ? 'not retrying until the service config changes' : `retrying in ${retryInMs} ms`;
          controller.reportError({
            code: 'drops_fetch_failed',
            message: `DropLayer "${latest.current.id}": ${code}: ${e instanceof Error ? e.message : String(e)} (${next})`,
            // Permanent errors stop this layer's fetching; the map itself keeps running.
            fatal: retryInMs === null,
          });
        },
      }),
  );

  // Request state and timers are reset only when the service config changes or on unmount.
  const configKey = JSON.stringify([baseUrl, apiKey, channel, radiusMeters ?? null, userId]);
  const startedKey = useRef<string | null>(null);
  useEffect(() => {
    if (startedKey.current !== null && startedKey.current !== configKey) {
      // Drops (and ids hidden on collect) of the previous config do not carry over.
      collected.current.clear();
      setDrops([]);
    }
    startedKey.current = configKey;
    tracker.start();
    return () => tracker.stop();
  }, [tracker, configKey]);

  const center = position?.coordinate ?? null;
  useEffect(() => {
    if (center) tracker.updatePosition(center, refetchDistance);
    // `center` is identified by lng/lat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracker, center?.lng, center?.lat, refetchDistance]);

  const visible = collected.current.size ? drops.filter((d) => !collected.current.has(d.id)) : drops;

  const layer = useDropLayer(props.id, visible, props.collectRadiusMeters ?? DEFAULT_COLLECT_RADIUS_METERS, props.collectorIds, (info) => {
    const current = latest.current;
    collected.current.add(info.dropId);
    // Send the layer without the drop now, so restoring it later re-adds it on the engine.
    layer.hideNow(info.dropId);
    forceRender();
    current.onCollect?.(info);
    const lastFix = controller.getLastFix();
    verifyDropCollect(
      { baseUrl: current.baseUrl, apiKey: current.apiKey },
      {
        dropId: info.dropId,
        collectId: info.collectId,
        userId: current.userId,
        fix: {
          lng: info.coordinate.lng,
          lat: info.coordinate.lat,
          accuracyMeters: lastFix?.accuracyMeters ?? 0,
          timestamp: Date.now(),
        },
      },
    ).then(
      (res) => latest.current.onCollectVerified?.({ ...info, receipt: res.receipt, replayed: res.replayed }),
      (e: unknown) => {
        const err = e instanceof DropsServiceError ? e : new DropsServiceError('NETWORK_ERROR', String(e), 0);
        if (shouldRestoreRejectedDrop(err.code, err.status) && collected.current.delete(info.dropId)) forceRender();
        latest.current.onCollectRejected?.({ ...info, code: err.code, message: err.message, status: err.status });
      },
    );
  });

  return null;
}
