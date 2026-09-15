/**
 * @module
 */

import { useEffect, useRef } from 'react';
import { useMapContext } from '../context';
import type { GeofenceProps } from '../types';

/**
 * A circular geofence. All geofences of a map are sent as one `setGeofences`
 * per frame; `onEnter` / `onExit` receive the engine's geofence events for this id.
 *
 * ```tsx
 * <Geofence id="plaza" center={plaza} radiusMeters={60} onEnter={e => ...} onExit={e => ...} />
 * ```
 */
export function Geofence({ id, center, radiusMeters, onEnter, onExit }: GeofenceProps): null {
  const { batcher, controller } = useMapContext('Geofence');
  const handlers = useRef({ onEnter, onExit });
  handlers.current = { onEnter, onExit };

  useEffect(() => {
    batcher.setGeofence({ id, center: { lng: center.lng, lat: center.lat }, radiusMeters });
  }, [batcher, id, center.lng, center.lat, radiusMeters]);

  useEffect(() => () => batcher.removeGeofence(id), [batcher, id]);

  useEffect(() => {
    const offEnter = controller.addEventListener('geofence:enter', (e) => {
      if (e.geofenceId === id) handlers.current.onEnter?.({ geofenceId: e.geofenceId, characterId: e.characterId });
    });
    const offExit = controller.addEventListener('geofence:exit', (e) => {
      if (e.geofenceId === id) handlers.current.onExit?.({ geofenceId: e.geofenceId, characterId: e.characterId });
    });
    return () => {
      offEnter();
      offExit();
    };
  }, [controller, id]);

  return null;
}
