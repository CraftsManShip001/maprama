/**
 * @module
 */

import { useEffect, useId } from 'react';
import type { CharacterSpec } from '@diorama/protocol';
import { useMapContext } from '../context';
import { resolveModel } from '../model';
import type { CharacterLayerProps } from '../types';

/**
 * Many characters from app data (e.g. nearby players). Characters are keyed by
 * `getId`; added, changed and removed items become one `upsertCharacters` and
 * one `removeCharacters` per frame. Layer characters use `follow: 'none'`.
 *
 * ```tsx
 * <CharacterLayer data={nearbyPlayers} getId={p => p.id} getPosition={p => p.coord} getModel={p => p.avatarUrl} />
 * ```
 */
export function CharacterLayer<T>(props: CharacterLayerProps<T>): null {
  const { batcher } = useMapContext('CharacterLayer');
  const sourceKey = `layer:${useId()}`;
  const { data, getId, getPosition, getModel, getName, getColor, getScale, getAnimations, showNameTags } = props;

  useEffect(() => {
    const specs: CharacterSpec[] = data.map((item) => {
      const position = getPosition(item);
      const spec: CharacterSpec = { id: getId(item), position: { lng: position.lng, lat: position.lat }, follow: 'none' };
      const model = resolveModel(getModel?.(item));
      if (model) spec.model = model;
      const name = getName?.(item);
      if (name !== undefined) spec.name = name;
      const color = getColor?.(item);
      if (color !== undefined) spec.color = color;
      const scale = getScale?.(item);
      if (scale !== undefined) spec.scale = scale;
      const animations = getAnimations?.(item);
      if (animations !== undefined) spec.animations = animations;
      if (showNameTags !== undefined) spec.showNameTag = showNameTags;
      return spec;
    });
    // The batcher ignores identical specs, so inline getters do not cause traffic.
    batcher.setCharacters(sourceKey, specs);
  });

  useEffect(() => () => batcher.removeCharacterSource(sourceKey), [batcher, sourceKey]);

  return null;
}
