/**
 * `@maprama/engine-native`: the native engine (v2) for `@maprama/react-native`.
 *
 * Importing this package registers the `native` engine host, so apps opt in with
 *
 * ```tsx
 * import '@maprama/engine-native';
 * <MapramaView engine="native" … />
 * ```
 *
 * Milestone M1 (DESIGN.md §11): the world as a flat MapLibre map, camera + gestures, `camera:change`,
 * `project` / `unproject`. Other commands are accepted and ignored (warn-logged) until M2/M3.
 *
 * @packageDocumentation
 */

import { registerEngineHost } from '@maprama/react-native';
import { NATIVE_ENGINE_HOST, NativeEngineHost } from './NativeEngineHost';

registerEngineHost(NATIVE_ENGINE_HOST, NativeEngineHost);

export { NATIVE_ENGINE_HOST, NativeEngineHost, createEngineId } from './NativeEngineHost';
export type { EngineEventMessage } from './specs/NativeMapramaEngineModule';
