/**
 * Runtime configuration read from `EXPO_PUBLIC_*` environment variables
 * (inlined by the Expo bundler). Never commit keys: put them in
 * `example/.env.local` (git-ignored) or export them in the shell.
 */

/** Base URL of the Maprama API (`npm run dev:local -w @maprama/api` listens on 8787). */
export const API_BASE_URL: string = process.env.EXPO_PUBLIC_MAPRAMA_API_URL ?? 'http://localhost:8787';

/** Client API key printed by the local dev server on start (`client key (dev only): mpr_...`). */
export const API_KEY: string = process.env.EXPO_PUBLIC_MAPRAMA_API_KEY ?? '';

/** Drop channel for `DropLayer source="service"`. */
export const DROPS_CHANNEL: string = process.env.EXPO_PUBLIC_MAPRAMA_DROPS_CHANNEL ?? 'coins';

/**
 * World URL for `world.kind: 'url'`. Defaults to the local API's Seongsu world
 * (start the dev server with `--world seongsu=../../tools/osm/samples/seongsu.world.json`).
 * Empty when no key is configured.
 */
export const WORLD_URL: string =
  process.env.EXPO_PUBLIC_MAPRAMA_WORLD_URL ??
  (API_KEY ? `${API_BASE_URL}/v1/worlds/seongsu.json?key=${encodeURIComponent(API_KEY)}` : '');

/** Probes the API (`GET /v1/usage`) with a short timeout. Resolves `true` when it answered 2xx. */
export async function probeApi(timeoutMs = 2500): Promise<boolean> {
  if (!API_KEY) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE_URL}/v1/usage`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
