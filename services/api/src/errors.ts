/** Stable machine-readable error codes returned as `{ error: { code, message } }`. */
export type ErrorCode =
  // 400
  | 'INVALID_REQUEST'
  | 'INVALID_JSON'
  // 401
  | 'MISSING_KEY'
  | 'INVALID_KEY'
  | 'MALFORMED_AUTHORIZATION'
  | 'QUERY_KEY_NOT_ALLOWED'
  // 403
  | 'FORBIDDEN_ROLE'
  // 404
  | 'NOT_FOUND'
  | 'WEBHOOK_NOT_CONFIGURED'
  // 409
  | 'COLLECT_ID_CONFLICT'
  // 413
  | 'PAYLOAD_TOO_LARGE'
  // 422 (collect verification)
  | 'DROP_NOT_FOUND'
  | 'DROP_EXPIRED'
  | 'TOO_FAR'
  | 'STALE_FIX'
  | 'ALREADY_COLLECTED'
  | 'TELEPORT'
  // 429
  | 'QUOTA_EXCEEDED'
  // 500
  | 'INTERNAL_ERROR';

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500;

/** Thrown by handlers; converted to a JSON error response by the app's error handler. */
export class ApiError extends Error {
  constructor(
    readonly status: ErrorStatus,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function errorBody(code: ErrorCode, message: string): { error: { code: ErrorCode; message: string } } {
  return { error: { code, message } };
}

export const badRequest = (message: string): ApiError => new ApiError(400, 'INVALID_REQUEST', message);
