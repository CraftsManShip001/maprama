/**
 * @module
 */

import { useEffect, useState } from 'react';
import type { CameraState } from '@maprama/protocol';
import { DEFAULT_THROTTLE_MS } from '../ref';
import type { MapramaViewRef, MapramaViewRefLike } from '../types';
import { useMapApi } from './useMapramaView';

/** Options for `useCameraState`. */
export interface UseCameraStateOptions {
  /** Minimum interval between updates in ms. Default 250. */
  throttleMs?: number;
}

/**
 * Subscribes to camera changes (`camera:change`) while mounted and returns the
 * latest camera state (`null` until the camera first moves). The map may mount
 * after the hook; the hook subscribes as soon as it mounts. When the map is
 * replaced, the hook returns `null` until the new map's camera moves.
 *
 * @param map the map ref or API; inside `MapramaView` pass `null` to use the enclosing map.
 */
export function useCameraState(map: MapramaViewRefLike, options: UseCameraStateOptions = {}): CameraState | null {
  const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
  const api = useMapApi(map);
  // The value is tagged with the map it came from, so a replaced map never shows the previous map's camera.
  const [state, setState] = useState<{ api: MapramaViewRef; value: CameraState } | null>(null);

  useEffect(() => {
    setState((prev) => (prev && prev.api !== api ? null : prev));
    if (!api) return undefined;
    return api.subscribe('camera:change', (event) => setState({ api, value: event.camera }), { throttleMs });
  }, [api, throttleMs]);

  return state && state.api === api ? state.value : null;
}
