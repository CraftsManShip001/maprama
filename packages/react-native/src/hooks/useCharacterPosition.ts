/**
 * @module
 */

import { useEffect, useState } from 'react';
import { DEFAULT_THROTTLE_MS } from '../ref';
import type { CharacterPosition, DioramaMapRef, DioramaMapRefLike } from '../types';
import { useMapApi } from './useDioramaMap';

/** Options for `useCharacterPosition`. */
export interface UseCharacterPositionOptions {
  /** Minimum interval between updates in ms (engine- and hook-side). Default 250. */
  throttleMs?: number;
}

/**
 * Subscribes to a character's position (`character:position`) while mounted
 * and returns the latest value (`null` until the first event). Unsubscribes on
 * unmount or when the map, `characterId` or `throttleMs` change.
 *
 * The map may mount after the hook (for example a conditionally rendered
 * `DioramaMap` holding the ref): the hook subscribes as soon as it mounts.
 * When the map is replaced (unmounted and mounted again), the hook returns
 * `null` until the new map reports a position.
 *
 * @param map the map ref (`useRef<DioramaMapRef>`) or API; inside `DioramaMap` pass `null` to use the enclosing map.
 * @param characterId character to follow; `null` pauses the subscription.
 */
export function useCharacterPosition(
  map: DioramaMapRefLike,
  characterId: string | null,
  options: UseCharacterPositionOptions = {},
): CharacterPosition | null {
  const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
  const api = useMapApi(map);
  // The value is tagged with the map it came from, so a replaced map never shows the previous map's position.
  const [state, setState] = useState<{ api: DioramaMapRef; value: CharacterPosition } | null>(null);

  useEffect(() => {
    setState((prev) => (prev && prev.api !== api ? null : prev));
    if (!api || characterId === null) return undefined;
    return api.subscribe(
      'character:position',
      (event) => setState({ api, value: { coordinate: event.coordinate, headingDeg: event.headingDeg, speedMps: event.speedMps } }),
      { id: characterId, throttleMs },
    );
  }, [api, characterId, throttleMs]);

  return state && state.api === api ? state.value : null;
}
