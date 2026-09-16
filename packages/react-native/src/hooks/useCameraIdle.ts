/**
 * @module
 */

import { useEffect, useState } from 'react';
import { DEFAULT_THROTTLE_MS } from '../ref';
import type { EngineEventOf, MapramaViewRef, MapramaViewRefLike } from '../types';
import { useMapApi } from './useMapramaView';

/** Options for `useCameraIdle`. */
export interface UseCameraIdleOptions {
  /** Minimum interval between idle events in ms. Default 250. */
  throttleMs?: number;
}

/** The last `camera:idle` payload: the camera at rest plus what it can see. */
export type CameraIdle = Omit<EngineEventOf<'camera:idle'>, 'type'>;

/**
 * Subscribes to `camera:idle` while mounted and returns the last one: the
 * camera the map came to rest at, the ground `bounds` and `radiusMeters` of the
 * visible area (the view minus `ui.contentInset`), and `reason` — `gesture`
 * (user input, including the engine's zoom buttons), `api` (the app's own
 * `setCamera` / `fitBounds`) or `follow`.
 *
 * The first value arrives one idle delay after the map is ready, without
 * waiting for the user to move anything, so a screen can make its first query
 * straight away:
 *
 * ```tsx
 * const idle = useCameraIdle(map);
 * useEffect(() => {
 *   if (idle) void loadPois(idle.camera.center, idle.radiusMeters);
 * }, [idle]);
 * ```
 *
 * `null` until the first event. When the map is replaced, the hook returns
 * `null` until the new map's camera reports in.
 *
 * @param map the map ref or API; inside `MapramaView` pass `null` to use the enclosing map.
 */
export function useCameraIdle(map: MapramaViewRefLike, options: UseCameraIdleOptions = {}): CameraIdle | null {
  const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
  const api = useMapApi(map);
  // Tagged with the map it came from, so a replaced map never shows the previous map's viewport.
  const [state, setState] = useState<{ api: MapramaViewRef; value: CameraIdle } | null>(null);

  useEffect(() => {
    setState((prev) => (prev && prev.api !== api ? null : prev));
    if (!api) return undefined;
    return api.subscribe(
      'camera:idle',
      ({ camera, bounds, radiusMeters, reason }) => setState({ api, value: { camera, bounds, radiusMeters, reason } }),
      { throttleMs },
    );
  }, [api, throttleMs]);

  return state && state.api === api ? state.value : null;
}
