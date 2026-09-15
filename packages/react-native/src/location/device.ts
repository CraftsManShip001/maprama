/**
 * Device location for `location.source: 'device'`.
 *
 * - With `expo-location` installed (optional peer dependency) the host watches
 *   the position and pushes fixes; the engine runs with the `external` source.
 * - Without it the engine reads `navigator.geolocation` inside the WebView
 *   (the host enables WebView geolocation).
 *
 * @module
 */

import type { LocationFix, LocationSourceKind } from '@maprama/protocol';
import type { MapramaLocationProps } from '../types';

/** The subset of `expo-location` used by the host. */
export interface ExpoLocationModule {
  requestForegroundPermissionsAsync(): Promise<{ status: string; granted?: boolean }>;
  watchPositionAsync(
    options: { accuracy?: number; timeInterval?: number; distanceInterval?: number },
    callback: (location: {
      coords: { latitude: number; longitude: number; accuracy: number | null; heading: number | null; speed: number | null };
      timestamp: number;
    }) => void,
  ): Promise<{ remove(): void }>;
  Accuracy?: { High?: number; BestForNavigation?: number };
}

declare const require: (id: string) => unknown;

let cached: ExpoLocationModule | null | undefined;

/** Loads `expo-location` if installed (the `require` is optional for Metro). Cached. */
export function loadExpoLocation(): ExpoLocationModule | null {
  if (cached !== undefined) return cached;
  try {
    const mod = require('expo-location') as ExpoLocationModule | { default?: ExpoLocationModule } | null;
    const resolved = mod && 'watchPositionAsync' in mod ? mod : (mod as { default?: ExpoLocationModule } | null)?.default;
    cached = resolved && typeof resolved.watchPositionAsync === 'function' ? resolved : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** @internal Clears the `expo-location` lookup cache (tests). */
export function resetExpoLocationCache(): void {
  cached = undefined;
}

/** How a `location` prop maps onto the engine and the host. */
export interface LocationPlan {
  /** Source sent to the engine. */
  engineSource: LocationSourceKind;
  /** The host watches `expo-location` and pushes fixes. */
  useExpoLocation: boolean;
  /** The WebView must allow `navigator.geolocation`. */
  webViewGeolocation: boolean;
}

/** Resolves the location plan for a `location` prop. */
export function planLocation(location: MapramaLocationProps | undefined): LocationPlan {
  const source = location?.source ?? 'external';
  if (source !== 'device') return { engineSource: source, useExpoLocation: false, webViewGeolocation: false };
  const provider = location?.provider ?? 'auto';
  const expo = provider !== 'webview' && loadExpoLocation() !== null;
  if (expo) return { engineSource: 'external', useExpoLocation: true, webViewGeolocation: false };
  return { engineSource: 'device', useExpoLocation: false, webViewGeolocation: true };
}

/**
 * Requests foreground permission and watches the position with `expo-location`.
 * Returns a stop function (safe to call before the watch started).
 */
export function startExpoLocationWatch(
  onFix: (fix: LocationFix) => void,
  onError: (code: 'location_unavailable' | 'location_permission_denied', message: string) => void,
): () => void {
  const mod = loadExpoLocation();
  if (!mod) {
    onError('location_unavailable', 'expo-location is not installed');
    return () => {};
  }
  let stopped = false;
  let subscription: { remove(): void } | null = null;
  (async () => {
    const permission = await mod.requestForegroundPermissionsAsync();
    if (stopped) return;
    if (permission.status !== 'granted' && permission.granted !== true) {
      onError('location_permission_denied', 'foreground location permission was not granted');
      return;
    }
    const sub = await mod.watchPositionAsync(
      { accuracy: mod.Accuracy?.BestForNavigation ?? mod.Accuracy?.High, timeInterval: 1000, distanceInterval: 1 },
      ({ coords, timestamp }) => {
        const fix: LocationFix = { lng: coords.longitude, lat: coords.latitude, timestamp };
        if (typeof coords.accuracy === 'number' && coords.accuracy >= 0) fix.accuracyMeters = coords.accuracy;
        if (typeof coords.heading === 'number' && coords.heading >= 0) fix.headingDeg = coords.heading;
        if (typeof coords.speed === 'number' && coords.speed >= 0) fix.speedMps = coords.speed;
        onFix(fix);
      },
    );
    if (stopped) sub.remove();
    else subscription = sub;
  })().catch((e: unknown) => {
    if (!stopped) onError('location_unavailable', e instanceof Error ? e.message : String(e));
  });
  return () => {
    stopped = true;
    subscription?.remove();
    subscription = null;
  };
}
