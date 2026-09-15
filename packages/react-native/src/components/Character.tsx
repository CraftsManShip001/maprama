/**
 * @module
 */

import { useEffect, useId, useMemo } from 'react';
import type { CharacterSpec } from '@maprama/protocol';
import { useMapContext } from '../context';
import { resolveModel } from '../model';
import type { CharacterProps } from '../types';

/** @internal Builds a protocol spec, omitting unset fields. */
export function toCharacterSpec(props: CharacterProps): CharacterSpec {
  const spec: CharacterSpec = { id: props.id };
  const model = resolveModel(props.model);
  if (model) spec.model = model;
  if (props.name !== undefined) spec.name = props.name;
  if (props.color !== undefined) spec.color = props.color;
  if (props.position !== undefined) spec.position = { lng: props.position.lng, lat: props.position.lat };
  if (props.follow !== undefined) spec.follow = props.follow;
  if (props.isPlayer !== undefined) spec.isPlayer = props.isPlayer;
  if (props.scale !== undefined) spec.scale = props.scale;
  if (props.animations !== undefined) spec.animations = props.animations;
  if (props.showNameTag !== undefined) spec.showNameTag = props.showNameTag;
  return spec;
}

/**
 * A character on the map (the player avatar or another actor). Renders
 * nothing; changes are diffed and batched into `upsertCharacters`, unmounting
 * sends `removeCharacters`. Removing a prop restores the engine default for it
 * (it is sent once as `null`); removing `position` leaves the character where it is.
 *
 * ```tsx
 * <Character id="me" isPlayer model={require('./hero.glb')} animations={{ walk: 'Walking_Loop' }} follow="location" />
 * ```
 */
export function Character(props: CharacterProps): null {
  const { batcher } = useMapContext('Character');
  const sourceKey = `character:${useId()}`;
  const spec = toCharacterSpec(props);
  const key = JSON.stringify(spec);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stable = useMemo(() => spec, [key]);

  useEffect(() => {
    batcher.setCharacters(sourceKey, [stable]);
  }, [batcher, sourceKey, stable]);

  useEffect(() => () => batcher.removeCharacterSource(sourceKey), [batcher, sourceKey]);

  return null;
}
