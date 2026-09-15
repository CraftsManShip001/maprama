/**
 * React context connecting declarative children to their `MapramaView`.
 *
 * @module
 */

import { createContext, useContext } from 'react';
import type { OverlayPosition } from '@maprama/protocol';
import type { CommandBatcher } from './batching';
import type { MapController } from './ref';

/** @internal Value provided by `MapramaView` to its children. */
export interface MapContextValue {
  controller: MapController;
  batcher: CommandBatcher;
  /** Per-anchor position listeners fed from one `overlay:positions` subscription. */
  overlayListeners: Map<string, (position: OverlayPosition) => void>;
}

/** @internal */
export const MapContext = createContext<MapContextValue | null>(null);

const mapMountListeners = new Set<() => void>();

/**
 * @internal Called by `MapramaView` after it mounts (its ref is attached) and
 * when it unmounts, so hooks holding a ref object can re-resolve it.
 */
export function notifyMapMountChange(): void {
  for (const listener of [...mapMountListeners]) listener();
}

/** @internal Subscribes to {@link notifyMapMountChange}. Returns the unsubscribe function. */
export function onMapMountChange(listener: () => void): () => void {
  mapMountListeners.add(listener);
  return () => {
    mapMountListeners.delete(listener);
  };
}

/** @internal Returns the map context or throws a descriptive error outside `MapramaView`. */
export function useMapContext(component: string): MapContextValue {
  const value = useContext(MapContext);
  if (!value) throw new Error(`<${component}> must be rendered inside <MapramaView>`);
  return value;
}
