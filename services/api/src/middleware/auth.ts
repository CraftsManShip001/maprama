import type { MiddlewareHandler } from 'hono';
import type { Role, ServiceDeps } from '../deps.js';
import { ApiError } from '../errors.js';
import { API_KEY_PATTERN, sha256Hex } from '../util/crypto.js';
import type { AppEnv } from '../util/http.js';
import { timingSafeEqualString } from '../verify.js';

export interface AuthOptions {
  /** Accept `?key=` (map clients that cannot set headers). Only for tile/world GETs. */
  allowQueryKey?: boolean;
}

/**
 * Resolves the API key from `Authorization: Bearer <key>` (or `?key=` when
 * allowed) and stores the key record in `c.var.apiKey`. Raw keys are never
 * logged or stored; lookups use the SHA-256 hash and a constant-time compare.
 */
export function authenticate(deps: ServiceDeps, opts: AuthOptions = {}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization');
    const queryKey = c.req.query('key');
    let raw: string | undefined;
    if (header !== undefined) {
      const m = /^Bearer[ ]+(\S+)\s*$/i.exec(header);
      if (!m) throw new ApiError(401, 'MALFORMED_AUTHORIZATION', 'Authorization header must be "Bearer <key>"');
      raw = m[1];
    } else if (queryKey !== undefined) {
      if (!opts.allowQueryKey) {
        throw new ApiError(401, 'QUERY_KEY_NOT_ALLOWED', 'The ?key= parameter is only accepted for tile and world requests; use the Authorization header');
      }
      raw = queryKey;
    }
    if (!raw) throw new ApiError(401, 'MISSING_KEY', 'An API key is required');
    if (!API_KEY_PATTERN.test(raw)) throw new ApiError(401, 'INVALID_KEY', 'Invalid API key');
    const hash = await sha256Hex(deps.crypto, raw);
    const record = await deps.keys.findByHash(hash);
    if (!record || !timingSafeEqualString(record.keyHash, hash) || (record.revokedAt ?? null) !== null) {
      throw new ApiError(401, 'INVALID_KEY', 'Invalid API key');
    }
    c.set('apiKey', record);
    await next();
  };
}

/** Allows only keys whose role is in `roles` (`403 FORBIDDEN_ROLE`). */
export function requireRole(...roles: Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = c.get('apiKey');
    if (!roles.includes(key.role)) {
      throw new ApiError(403, 'FORBIDDEN_ROLE', `This endpoint requires one of the roles: ${roles.join(', ')}`);
    }
    await next();
  };
}
