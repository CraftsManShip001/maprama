/**
 * The engine host abstraction. A host owns a render surface (a WebView today,
 * a native view later) and moves `@maprama/protocol` messages between the
 * JavaScript map controller and the engine. App code never talks to a host
 * directly, so hosts can be swapped without changing app code.
 *
 * @module
 */

import type { ComponentType } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import {
  decodeEvent,
  encodeCommand,
  type EngineCommand,
  type EngineEvent,
  type EngineInfo,
} from '@maprama/protocol';

/** A live connection to one engine instance. */
export interface EngineHost {
  /** Host kind this instance was created by (e.g. `'web'`). */
  readonly kind: string;
  /**
   * Sends one command to the engine. Hosts do not queue: commands sent before
   * the engine is loaded may be lost. The map controller queues until `ready`.
   */
  send(command: EngineCommand): void;
  /** Subscribes to decoded, validated engine events. Returns an unsubscribe function. */
  onEvent(listener: (event: EngineEvent) => void): () => void;
  /** Resolves with the engine info of the first `ready` event. */
  readonly ready: Promise<EngineInfo>;
  /** Releases listeners. Further `send` calls are ignored. Idempotent. */
  destroy(): void;
}

/** A failure inside the host (not an engine `error` event). */
export interface EngineHostError {
  code: string;
  message: string;
  /** True when the host cannot recover by itself. */
  fatal: boolean;
}

/** Options the map passes to a host component. */
export interface EngineHostOptions {
  /**
   * The engine reads the device position itself (WebView `navigator.geolocation`).
   * Hosts must enable platform geolocation access when set.
   */
  geolocationEnabled?: boolean;
  /** Test id for the host's render surface. */
  testID?: string;
}

/** Props every engine host component receives from `MapramaView`. */
export interface EngineHostComponentProps {
  /** Fills the map. */
  style?: StyleProp<ViewStyle>;
  /**
   * Called with a new {@link EngineHost} after mount (and again with a new
   * instance if the host is re-created). The previous instance is destroyed by the host.
   */
  onHost: (host: EngineHost) => void;
  /** Called for host failures and for engine messages that fail protocol validation. */
  onHostError: (error: EngineHostError) => void;
  options: EngineHostOptions;
}

/** A React component that renders an engine and reports its {@link EngineHost}. */
export type EngineHostComponent = ComponentType<EngineHostComponentProps>;

/** A message-string based host plus the entry point for incoming raw messages. */
export interface MessageChannelHost {
  host: EngineHost;
  /**
   * Feeds one raw message from the engine. Valid events are delivered to
   * listeners; returns the decode error for invalid input, `null` otherwise. Never throws.
   */
  receive(raw: unknown): string | null;
}

/**
 * Creates an {@link EngineHost} for transports that carry encoded envelope
 * strings (WebView `postMessage`, WebSocket, a JSI string bridge...).
 *
 * @param kind host kind reported by `host.kind`.
 * @param post delivers one encoded command envelope to the engine.
 */
export function createMessageChannelHost(kind: string, post: (data: string) => void): MessageChannelHost {
  const listeners = new Set<(event: EngineEvent) => void>();
  let seq = 0;
  let destroyed = false;
  let resolveReady: (info: EngineInfo) => void = () => {};
  const ready = new Promise<EngineInfo>((resolve) => {
    resolveReady = resolve;
  });

  const host: EngineHost = {
    kind,
    ready,
    send(command) {
      if (destroyed) return;
      post(encodeCommand(command, seq++));
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    destroy() {
      destroyed = true;
      listeners.clear();
    },
  };

  return {
    host,
    receive(raw) {
      if (destroyed) return null;
      const decoded = decodeEvent(raw as string);
      if (!decoded.ok) return decoded.error;
      const event = decoded.value.msg;
      if (event.type === 'ready') resolveReady(event.engine);
      for (const listener of [...listeners]) listener(event);
      return null;
    },
  };
}
