/**
 * Errors surfaced by the library.
 *
 * @module
 */

import type { EngineErrorCode } from '@maprama/protocol';

/**
 * Error codes produced by the React Native host itself (engine codes such as
 * `unsupported` or `world_load_failed` are passed through unchanged).
 *
 * - `timeout`: a request or travel did not complete in time.
 * - `travel_cancelled`: the travel was cancelled (`cancelTravel` or a newer travel).
 * - `engine_reloaded`: the engine restarted while the operation was pending.
 * - `unmounted`: the map unmounted while the operation was pending.
 * - `invalid_message`: the engine sent a message that failed protocol validation.
 * - `host_crashed` / `host_load_failed`: the engine host (e.g. the WebView) failed.
 * - `location_unavailable` / `location_permission_denied`: device location could not start.
 * - `drops_fetch_failed`: `DropLayer source="service"` could not load nearby drops.
 * - `listener_error`: an app callback threw.
 */
export type HostErrorCode =
  | 'timeout'
  | 'travel_cancelled'
  | 'engine_reloaded'
  | 'unmounted'
  | 'invalid_message'
  | 'host_crashed'
  | 'host_load_failed'
  | 'location_unavailable'
  | 'location_permission_denied'
  | 'drops_fetch_failed'
  | 'listener_error';

/** Any error code the library can report. */
export type MapramaErrorCode = HostErrorCode | EngineErrorCode;

/** Error thrown by rejected promises of {@link MapramaViewRef} methods. */
export class MapramaError extends Error {
  /** Stable error code, see {@link MapramaErrorCode}. */
  readonly code: MapramaErrorCode;

  constructor(code: MapramaErrorCode, message: string) {
    super(message);
    this.name = 'MapramaError';
    this.code = code;
  }
}

/**
 * Maps engine-specific codes onto the protocol's well-known codes. Engines that
 * predate the protocol's `unsupported` code report `NOT_IMPLEMENTED`; both mean
 * "this engine does not implement the command".
 */
export function normalizeErrorCode(code: string): MapramaErrorCode {
  return code === 'NOT_IMPLEMENTED' ? 'unsupported' : code;
}
