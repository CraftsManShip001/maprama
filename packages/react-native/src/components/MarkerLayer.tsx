/**
 * @module
 */

import { useEffect, useRef } from 'react';
import { Image } from 'react-native';
import { MARKER_SHAPES, type MarkerIcon, type MarkerSpec } from '@maprama/protocol';
import type { MarkerLayerState } from '../batching';
import { useMapContext } from '../context';
import type { MarkerIconInput, MarkerLayerProps, MarkerPressInfo } from '../types';

/** Marker height in dp when `size` is absent (the engine's default). */
export const DEFAULT_MARKER_SIZE = 36;
/** Scale of the selected marker when `selectedScale` is absent (the engine's default). */
export const DEFAULT_SELECTED_SCALE = 1.25;

const SHAPES = new Set<string>(MARKER_SHAPES);

/**
 * @internal Resolves a {@link MarkerIconInput}: `'pin'` / `'dot'` stay base
 * shapes, `require()` assets go through `Image.resolveAssetSource`, other
 * strings and `{ uri }` objects become image icons.
 */
export function resolveMarkerIcon(input: MarkerIconInput | undefined | null): MarkerIcon | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === 'number') {
    const uri = Image.resolveAssetSource(input)?.uri;
    return uri ? { uri } : undefined;
  }
  if (typeof input === 'string') return SHAPES.has(input) ? (input as MarkerIcon) : input ? { uri: input } : undefined;
  return input.uri ? { uri: input.uri } : undefined;
}

/**
 * A layer of app-owned map pins drawn by the engine: fixed screen size, pin tip
 * on the coordinate, priority-based collision shared with the map labels, an
 * accessibility label per marker and a press that reports the screen point.
 *
 * Changes send one `setMarkerLayer` per frame; unmounting sends
 * `removeMarkerLayer`. The engine matches markers by id, so an update that only
 * changes `getColor` or `selectedId` neither reloads an icon nor recreates a view.
 *
 * ```tsx
 * <MarkerLayer
 *   id="poi" data={pois} getId={(p) => p.id} getCoordinate={(p) => p.coord}
 *   getIcon={(p) => ({ uri: p.iconSvg })} getColor={(p) => FACTION[p.faction]}
 *   getPriority={(p) => p.rank} getAlwaysVisible={(p) => p.partner}
 *   getAccessibilityLabel={(p) => `${p.title}, ${p.faction}`}
 *   selectedId={selected} onPress={(e) => openSheet(e.markerId, e.point)}
 * />
 * ```
 */
export function MarkerLayer<T>(props: MarkerLayerProps<T>): null {
  const { batcher, controller } = useMapContext('MarkerLayer');
  const { id } = props;
  const handler = useRef(props.onPress);
  handler.current = props.onPress;

  const markers = props.data.map((item): MarkerSpec => {
    const coordinate = props.getCoordinate(item);
    const marker: MarkerSpec = { id: props.getId(item), coordinate: { lng: coordinate.lng, lat: coordinate.lat } };
    const icon = resolveMarkerIcon(props.getIcon?.(item));
    if (icon !== undefined) marker.icon = icon;
    const color = props.getColor?.(item);
    if (color !== undefined) marker.color = color;
    const priority = props.getPriority?.(item);
    if (priority !== undefined) marker.priority = priority;
    const alwaysVisible = props.getAlwaysVisible?.(item);
    if (alwaysVisible !== undefined) marker.alwaysVisible = alwaysVisible;
    const label = props.getAccessibilityLabel?.(item);
    if (label !== undefined) marker.accessibilityLabel = label;
    const anchorHeight = props.getAnchorHeight?.(item);
    if (anchorHeight !== undefined) marker.anchorHeight = anchorHeight;
    const snap = props.getSnapToBuilding?.(item);
    if (snap !== undefined) marker.snapToBuilding = snap;
    return marker;
  });

  // Registering is cheap and diffed by the batcher: an unchanged layer sends nothing.
  useEffect(() => {
    const state: MarkerLayerState = { markers };
    if (props.selectedId !== undefined) state.selectedId = props.selectedId;
    if (props.selectedScale !== undefined) state.selectedScale = props.selectedScale;
    if (props.size !== undefined) state.size = props.size;
    if (props.anchor !== undefined) state.anchor = props.anchor;
    batcher.setMarkerLayer(id, state);
  });

  useEffect(() => () => batcher.removeMarkerLayer(id), [batcher, id]);

  useEffect(
    () =>
      controller.addEventListener('marker:press', (e) => {
        if (e.layerId !== id) return;
        const info: MarkerPressInfo = {
          layerId: e.layerId,
          markerId: e.markerId,
          coordinate: e.coordinate,
          point: { x: e.point.x, y: e.point.y },
        };
        handler.current?.(info);
      }),
    [controller, id],
  );

  return null;
}
