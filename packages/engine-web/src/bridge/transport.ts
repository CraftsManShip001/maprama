/**
 * Transports carry encoded protocol envelopes (JSON strings) between a host
 * and the engine. The engine only depends on {@link Transport}.
 *
 * @module
 */

import { decodeEvent, encodeCommand, type EngineCommand, type EngineEvent } from '@maprama/protocol';

/** Engine-side view of a message channel. */
export interface Transport {
  /** Engine → host: sends one encoded event envelope. */
  send(data: string): void;
  /** Host → engine: subscribes to encoded command envelopes. Returns an unsubscribe function. */
  onMessage(listener: (data: string) => void): () => void;
  /** Releases resources (event listeners). */
  close?(): void;
}

/** In-page transport for playgrounds, docs and tests: also exposes the host side. */
export interface DirectTransport extends Transport {
  /** Host side: sends a command object (encoded with an increasing `seq`) or a raw string. */
  postCommand(command: EngineCommand | string): void;
  /** Host side: receives decoded, validated events (invalid ones are reported with `event === null`). */
  onEvent(listener: (event: EngineEvent | null, raw: string) => void): () => void;
}

/**
 * Creates an in-page transport. Messages posted before the other side
 * subscribes are buffered and flushed on the first subscription. Delivery is
 * synchronous.
 */
export function createDirectTransport(): DirectTransport {
  const toEngine = new Set<(data: string) => void>();
  const toHost = new Set<(event: EngineEvent | null, raw: string) => void>();
  const engineBacklog: string[] = [];
  const hostBacklog: string[] = [];
  let seq = 0;

  const deliverToHost = (raw: string): void => {
    const decoded = decodeEvent(raw);
    const event = decoded.ok ? decoded.value.msg : null;
    for (const cb of [...toHost]) cb(event, raw);
  };

  return {
    send(data) {
      if (!toHost.size) { hostBacklog.push(data); return; }
      deliverToHost(data);
    },
    onMessage(listener) {
      toEngine.add(listener);
      if (engineBacklog.length) for (const raw of engineBacklog.splice(0)) listener(raw);
      return () => { toEngine.delete(listener); };
    },
    postCommand(command) {
      const raw = typeof command === 'string' ? command : encodeCommand(command, seq++);
      if (!toEngine.size) { engineBacklog.push(raw); return; }
      for (const cb of [...toEngine]) cb(raw);
    },
    onEvent(listener) {
      toHost.add(listener);
      if (hostBacklog.length) for (const raw of hostBacklog.splice(0)) deliverToHost(raw);
      return () => { toHost.delete(listener); };
    },
    close() {
      toEngine.clear();
      toHost.clear();
    },
  };
}

interface RNWebViewWindow {
  ReactNativeWebView?: { postMessage(data: string): void };
}

/**
 * Transport for running inside `react-native-webview`: commands arrive as
 * `message` events on `window` (iOS) or `document` (Android); events are sent
 * with `window.ReactNativeWebView.postMessage`. When that bridge is absent
 * (e.g. the page is framed on the web) events go to `window.parent`.
 */
export function createWebViewTransport(win: Window = window): Transport {
  const listeners = new Set<(data: string) => void>();
  const onMsg = (e: Event): void => {
    const data = (e as MessageEvent).data;
    if (typeof data !== 'string') return;
    for (const cb of [...listeners]) cb(data);
  };
  win.addEventListener('message', onMsg);
  win.document?.addEventListener('message', onMsg);
  return {
    send(data) {
      const rn = (win as unknown as RNWebViewWindow).ReactNativeWebView;
      if (rn && typeof rn.postMessage === 'function') rn.postMessage(data);
      else if (win.parent && win.parent !== win) win.parent.postMessage(data, '*');
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    close() {
      listeners.clear();
      win.removeEventListener('message', onMsg);
      win.document?.removeEventListener('message', onMsg);
    },
  };
}
