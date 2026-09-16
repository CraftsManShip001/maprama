/**
 * @module
 */

import { useEffect, useRef } from 'react';
import type { InfoCardState } from '../batching';
import { useMapContext } from '../context';
import type { InfoCardProps } from '../types';

/**
 * A holographic place card the engine draws floating over a coordinate: a
 * ground dot, a leader line and a glass card with a title, subtitle, badges, a
 * rating, detail rows and action buttons.
 *
 * Mount as many as you like — `id` is the key. Changes send one `setInfoCard`
 * per frame for the cards that really changed; unmounting sends
 * `removeInfoCard`.
 *
 * **The engine does not open cards and does not move the camera.** A card
 * appears because your app rendered it, and the camera moves because your app
 * called `ref.focusOn`. That is the point: how a tap turns into a camera move
 * and a card is your product decision, not the library's.
 *
 * ```tsx
 * <MarkerLayer … onPress={async (e) => {
 *   await map.current?.focusOn(e.coordinate, { pitch: 55, animate: true });
 *   setOpen(e.markerId);
 * }} />
 * {open ? (
 *   <InfoCard
 *     id={open}
 *     coordinate={place.coordinate}
 *     anchor="roof"
 *     dismissible
 *     content={{
 *       title: place.name,
 *       subtitle: place.category,
 *       icon: 'cafe',
 *       badges: [{ text: '영업 중', tone: 'good' }],
 *       rating: { value: place.rating, count: place.reviews },
 *       rows: [{ icon: 'hours', text: '22:00 영업 종료' }],
 *       actions: [{ id: 'route', label: '길찾기', primary: true }],
 *     }}
 *     onPress={(e) => (e.actionId === 'route' ? startRoute(place) : undefined)}
 *     onDismiss={() => setOpen(null)}
 *   />
 * ) : null}
 * ```
 */
export function InfoCard(props: InfoCardProps): null {
  const { batcher, controller } = useMapContext('InfoCard');
  const { id } = props;
  const handlers = useRef({ onPress: props.onPress, onDismiss: props.onDismiss });
  handlers.current = { onPress: props.onPress, onDismiss: props.onDismiss };

  // Registering is cheap and diffed by the batcher: an unchanged card sends nothing.
  useEffect(() => {
    const state: InfoCardState = { coordinate: { lng: props.coordinate.lng, lat: props.coordinate.lat }, content: props.content };
    if (props.anchor !== undefined) state.anchor = props.anchor;
    if (props.heightMeters !== undefined) state.heightMeters = props.heightMeters;
    if (props.beam !== undefined) state.beam = props.beam;
    if (props.dismissible !== undefined) state.dismissible = props.dismissible;
    batcher.setInfoCard(id, state);
  });

  useEffect(() => () => batcher.removeInfoCard(id), [batcher, id]);

  useEffect(() => {
    const offPress = controller.addEventListener('infoCard:press', (e) => {
      if (e.id !== id) return;
      handlers.current.onPress?.(e.actionId === undefined ? { id: e.id } : { id: e.id, actionId: e.actionId });
    });
    const offDismiss = controller.addEventListener('infoCard:dismiss', (e) => {
      if (e.id === id) handlers.current.onDismiss?.({ id: e.id });
    });
    return () => {
      offPress();
      offDismiss();
    };
  }, [controller, id]);

  return null;
}
