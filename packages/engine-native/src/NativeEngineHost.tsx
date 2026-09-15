/**
 * v2 engine host: the native engine (C++ core + MapLibre Native) behind the `MapramaNativeView` Fabric
 * component and the `MapramaEngineModule` TurboModule.
 *
 * The envelope path is identical to the WebView host: `createMessageChannelHost` encodes commands and
 * decodes/validates events; only the transport differs. Commands sent within one JS task are flushed
 * together in a microtask (`postMessages`, DESIGN.md §4.3); order is preserved and nothing is merged.
 *
 * @module
 */

import { useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { createMessageChannelHost, type EngineHostComponentProps } from '@maprama/react-native';
import MapramaNativeView from './specs/MapramaNativeViewNativeComponent';
import NativeMapramaEngineModule, { type Spec } from './specs/NativeMapramaEngineModule';
import { attachEngineReceiver, ensureEngineEvents } from './events';

/** Host kind registered by this package (`<MapramaView engine="native">`). */
export const NATIVE_ENGINE_HOST = 'native';

let engineCounter = 0;

/** A process-unique engine id. */
export function createEngineId(): string {
  engineCounter += 1;
  return `maprama-native-${Date.now().toString(36)}-${engineCounter.toString(36)}`;
}

let moduleOverride: Spec | null | undefined;

/** @internal Test hook: replaces the TurboModule (`undefined` restores the real one). */
export function setEngineModuleForTesting(module: Spec | null | undefined): void {
  moduleOverride = module;
}

function engineModule(): Spec | null {
  return moduleOverride !== undefined ? moduleOverride : NativeMapramaEngineModule;
}

/** Batches `post` calls of one JS task into a single `postMessages` crossing. */
function createBatchedPost(module: Spec, engineId: string): { post: (data: string) => void; cancel: () => void } {
  let pending: string[] = [];
  let scheduled = false;
  let cancelled = false;
  const flush = () => {
    scheduled = false;
    if (cancelled || pending.length === 0) return;
    const batch = pending;
    pending = [];
    if (batch.length === 1) module.postMessage(engineId, batch[0]!);
    else module.postMessages(engineId, batch);
  };
  return {
    post(data) {
      if (cancelled) return;
      pending.push(data);
      if (!scheduled) {
        scheduled = true;
        void Promise.resolve().then(flush);
      }
    },
    cancel() {
      cancelled = true;
      pending = [];
    },
  };
}

/** Renders the native map view and reports an `EngineHost` of kind `native`. */
export function NativeEngineHost({ style, onHost, onHostError, options }: EngineHostComponentProps) {
  const [engineId] = useState(createEngineId);
  const callbacks = useRef({ onHost, onHostError });
  callbacks.current = { onHost, onHostError };
  const module = engineModule();
  // Subscribe before the native view mounts: its engine emits `ready` as soon as it exists.
  if (module) ensureEngineEvents(module);

  useEffect(() => {
    if (!module) {
      callbacks.current.onHostError({
        code: 'host_load_failed',
        message:
          'MapramaEngineModule is not linked: @maprama/engine-native needs a development build (New Architecture) that includes its native code',
        fatal: true,
      });
      return undefined;
    }
    const transport = createBatchedPost(module, engineId);
    const channel = createMessageChannelHost(NATIVE_ENGINE_HOST, transport.post);
    callbacks.current.onHost(channel.host);
    const detach = attachEngineReceiver(engineId, (envelope) => {
      const error = channel.receive(envelope);
      if (error) callbacks.current.onHostError({ code: 'invalid_message', message: error, fatal: false });
    });
    return () => {
      detach();
      transport.cancel();
      channel.host.destroy();
    };
  }, [engineId, module]);

  if (!module) return null;
  return <MapramaNativeView engineId={engineId} testID={options.testID} style={[styles.fill, style]} />;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
