/**
 * @module
 */

import { useContext, useEffect, useState } from 'react';
import { MapContext, onMapMountChange } from '../context';
import type { MapramaViewRef, MapramaViewRefLike } from '../types';

/**
 * Returns the imperative API of the enclosing `MapramaView` (the same object as
 * its `ref`). Use inside components rendered as children of `MapramaView`.
 *
 * @throws Error when called outside `MapramaView`.
 */
export function useMapramaView(): MapramaViewRef {
  const value = useContext(MapContext);
  if (!value) throw new Error('useMapramaView() must be called inside <MapramaView>');
  return value.controller;
}

/** @internal Resolves a {@link MapramaViewRefLike} to the map API (or `null`). */
export function resolveMapRef(map: MapramaViewRefLike): MapramaViewRef | null {
  if (!map) return null;
  if ('current' in map) return map.current;
  return map;
}

/**
 * @internal Resolves `map` (or, when it resolves to nothing, the enclosing map)
 * after commit, and again whenever any `MapramaView` mounts or unmounts. A ref
 * object whose map mounts after the hook (e.g. a conditionally rendered map)
 * is therefore picked up, and a replaced map is followed.
 */
export function useMapApi(map: MapramaViewRefLike): MapramaViewRef | null {
  const context = useContext(MapContext);
  const [api, setApi] = useState<MapramaViewRef | null>(null);
  useEffect(() => {
    const update = (): void => setApi(resolveMapRef(map) ?? context?.controller ?? null);
    update();
    return onMapMountChange(update);
  }, [map, context]);
  return api;
}
