/**
 * @module
 */

import { useContext, useEffect, useState } from 'react';
import { MapContext, onMapMountChange } from '../context';
import type { DioramaMapRef, DioramaMapRefLike } from '../types';

/**
 * Returns the imperative API of the enclosing `DioramaMap` (the same object as
 * its `ref`). Use inside components rendered as children of `DioramaMap`.
 *
 * @throws Error when called outside `DioramaMap`.
 */
export function useDioramaMap(): DioramaMapRef {
  const value = useContext(MapContext);
  if (!value) throw new Error('useDioramaMap() must be called inside <DioramaMap>');
  return value.controller;
}

/** @internal Resolves a {@link DioramaMapRefLike} to the map API (or `null`). */
export function resolveMapRef(map: DioramaMapRefLike): DioramaMapRef | null {
  if (!map) return null;
  if ('current' in map) return map.current;
  return map;
}

/**
 * @internal Resolves `map` (or, when it resolves to nothing, the enclosing map)
 * after commit, and again whenever any `DioramaMap` mounts or unmounts. A ref
 * object whose map mounts after the hook (e.g. a conditionally rendered map)
 * is therefore picked up, and a replaced map is followed.
 */
export function useMapApi(map: DioramaMapRefLike): DioramaMapRef | null {
  const context = useContext(MapContext);
  const [api, setApi] = useState<DioramaMapRef | null>(null);
  useEffect(() => {
    const update = (): void => setApi(resolveMapRef(map) ?? context?.controller ?? null);
    update();
    return onMapMountChange(update);
  }, [map, context]);
  return api;
}
