/**
 * Engine host registry. `MapramaView` renders the host registered for its
 * `engine` prop (default `'web'`). A future native engine package calls
 * `registerEngineHost('native', NativeEngineHost)` and apps opt in with
 * `<MapramaView engine="native">` — no other app code changes.
 *
 * @module
 */

import type { EngineHostComponent } from './EngineHost';
import { WebViewEngineHost } from './WebViewEngineHost';

/** Kind of the built-in WebView host. */
export const DEFAULT_ENGINE_HOST = 'web';

const hosts = new Map<string, EngineHostComponent>([[DEFAULT_ENGINE_HOST, WebViewEngineHost]]);

/**
 * Registers (or replaces) the host component for `kind`. Returns a function
 * that restores the previous registration.
 */
export function registerEngineHost(kind: string, component: EngineHostComponent): () => void {
  if (!kind) throw new TypeError('registerEngineHost: kind must be a non-empty string');
  const previous = hosts.get(kind);
  hosts.set(kind, component);
  return () => {
    if (hosts.get(kind) !== component) return;
    if (previous) hosts.set(kind, previous);
    else hosts.delete(kind);
  };
}

/** Returns the host component registered for `kind`, if any. */
export function getEngineHost(kind: string): EngineHostComponent | undefined {
  return hosts.get(kind);
}

/** Registered host kinds. */
export function getEngineHostKinds(): string[] {
  return [...hosts.keys()];
}
