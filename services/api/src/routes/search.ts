import type { Hono } from 'hono';
import { SEARCH_LIMITS } from '../config.js';
import type { ServiceDeps } from '../deps.js';
import { badRequest } from '../errors.js';
import { authenticate } from '../middleware/auth.js';
import { meter } from '../middleware/usage.js';
import { bigrams, normalizeText } from '../search/normalize.js';
import { rankPlaces } from '../search/rank.js';
import { parseLngLat } from '../util/geo.js';
import { numberParam, type AppEnv } from '../util/http.js';

export function registerSearchRoutes(app: Hono<AppEnv>, deps: ServiceDeps): void {
  const auth = authenticate(deps);

  app.get('/v1/search', auth, meter(deps, 'search'), async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (!q || q.length > SEARCH_LIMITS.maxQueryLength) throw badRequest(`"q" must be 1-${SEARCH_LIMITS.maxQueryLength} characters`);
    const queryNorm = normalizeText(q);
    if (!queryNorm) throw badRequest('"q" contains no searchable characters');
    const limit = numberParam(c.req.query('limit'), 'limit', {
      min: 1,
      max: SEARCH_LIMITS.maxLimit,
      fallback: SEARCH_LIMITS.defaultLimit,
      integer: true,
    });
    const nearRaw = c.req.query('near');
    const near = nearRaw === undefined ? undefined : parseLngLat(nearRaw);
    if (near === null) throw badRequest('"near" must be "lng,lat"');

    const chars = Array.from(queryNorm);
    const prefix = chars.length === 1;
    const tokens = prefix ? [chars[0]!] : bigrams(queryNorm).slice(0, 32);
    const candidates = await deps.places.searchCandidates({
      queryNorm,
      tokens,
      prefix,
      ...(near ? { near } : {}),
      limit: Math.min(200, Math.max(limit * 10, 50)),
    });
    const results = rankPlaces(candidates, queryNorm, near).slice(0, limit);
    return c.json({
      query: q,
      results: results.map((r) => ({
        id: r.id,
        kind: r.kind,
        name: r.name,
        address: r.address ?? null,
        category: r.category ?? null,
        coordinate: r.coordinate,
        ...(r.distanceMeters !== undefined ? { distanceMeters: r.distanceMeters } : {}),
        score: Math.round(r.score * 10_000) / 10_000,
      })),
    });
  });

  app.get('/v1/reverse', auth, meter(deps, 'search'), async (c) => {
    const lng = numberParam(c.req.query('lng'), 'lng', { min: -180, max: 180 });
    const lat = numberParam(c.req.query('lat'), 'lat', { min: -90, max: 90 });
    const radius = numberParam(c.req.query('radius'), 'radius', {
      min: 1,
      max: SEARCH_LIMITS.reverseMaxRadiusMeters,
      fallback: SEARCH_LIMITS.reverseMaxRadiusMeters,
    });
    const hit = await deps.places.nearest({ lng, lat }, radius, 'address');
    return c.json({
      result: hit
        ? {
            id: hit.place.id,
            name: hit.place.name,
            address: hit.place.address ?? null,
            coordinate: hit.place.coordinate,
            distanceMeters: Math.round(hit.distanceMeters * 10) / 10,
          }
        : null,
    });
  });
}
