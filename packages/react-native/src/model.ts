/**
 * Model source resolution.
 *
 * @module
 */

import { Image } from 'react-native';
import type { ModelSource } from '@diorama/protocol';
import type { ModelInput } from './types';

/**
 * Resolves a {@link ModelInput}: `require()` asset numbers through
 * `Image.resolveAssetSource(n).uri`, strings as URIs, objects as-is.
 * Returns `undefined` for missing or unresolvable input.
 */
export function resolveModel(input: ModelInput | undefined | null): ModelSource | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === 'number') {
    const uri = Image.resolveAssetSource(input)?.uri;
    return uri ? { uri } : undefined;
  }
  if (typeof input === 'string') return input ? { uri: input } : undefined;
  return input.uri ? { uri: input.uri } : undefined;
}
