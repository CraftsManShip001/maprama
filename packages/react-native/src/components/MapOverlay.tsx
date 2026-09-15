/**
 * @module
 */

import { useEffect, useId, useRef } from 'react';
import { Animated, StyleSheet, type LayoutChangeEvent } from 'react-native';
import type { OverlayPosition } from '@diorama/protocol';
import { useMapContext } from '../context';
import type { MapOverlayAnchor, MapOverlayProps } from '../types';

const ANCHORS: Record<MapOverlayAnchor, [number, number]> = {
  center: [0.5, 0.5],
  top: [0.5, 0],
  bottom: [0.5, 1],
  left: [0, 0.5],
  right: [1, 0.5],
  'top-left': [0, 0],
  'top-right': [1, 0],
  'bottom-left': [0, 1],
  'bottom-right': [1, 1],
};

/**
 * A React Native view pinned to a map coordinate. The anchor is sent with
 * `setOverlayAnchors`; screen positions from `overlay:positions` are applied
 * to `Animated` values (no React re-render per frame), so overlays follow the
 * camera on both the old architecture and Fabric.
 *
 * ```tsx
 * <MapOverlay coordinate={shop.coord} anchor="bottom"><ShopCard /></MapOverlay>
 * ```
 */
export function MapOverlay({
  coordinate,
  anchor = 'bottom',
  offset,
  hideWhenOffscreen = true,
  id: idProp,
  style,
  pointerEvents = 'box-none',
  testID,
  children,
}: MapOverlayProps) {
  const { batcher, overlayListeners } = useMapContext('MapOverlay');
  const generatedId = `overlay:${useId()}`;
  const id = idProp ?? generatedId;

  const translate = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const size = useRef<{ width: number; height: number } | null>(null);
  const last = useRef<OverlayPosition | null>(null);
  const layout = useRef({ anchor, offset, hideWhenOffscreen });
  layout.current = { anchor, offset, hideWhenOffscreen };

  const apply = useRef(() => {
    const pos = last.current;
    const measured = size.current;
    if (!pos || !measured) return;
    const [ax, ay] = ANCHORS[layout.current.anchor] ?? ANCHORS.bottom;
    translate.setValue({
      x: pos.x - measured.width * ax + (layout.current.offset?.x ?? 0),
      y: pos.y - measured.height * ay + (layout.current.offset?.y ?? 0),
    });
    opacity.setValue(pos.visible || !layout.current.hideWhenOffscreen ? 1 : 0);
  }).current;

  useEffect(() => {
    apply();
  }, [apply, anchor, offset?.x, offset?.y, hideWhenOffscreen]);

  useEffect(() => {
    batcher.setOverlayAnchor({ id, coordinate: { lng: coordinate.lng, lat: coordinate.lat } });
  }, [batcher, id, coordinate.lng, coordinate.lat]);

  useEffect(() => {
    overlayListeners.set(id, (position) => {
      last.current = position;
      apply();
    });
    return () => {
      overlayListeners.delete(id);
      batcher.removeOverlayAnchor(id);
    };
  }, [batcher, overlayListeners, id, apply]);

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    size.current = { width, height };
    apply();
  };

  return (
    <Animated.View
      testID={testID}
      pointerEvents={pointerEvents}
      onLayout={onLayout}
      style={[styles.overlay, style, { opacity, transform: [{ translateX: translate.x }, { translateY: translate.y }] }]}
    >
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', left: 0, top: 0 },
});
