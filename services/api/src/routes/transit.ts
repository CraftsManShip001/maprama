import type { Hono } from 'hono';
import { TRANSIT_LIMITS } from '../config.js';
import type { ServiceDeps } from '../deps.js';
import { ApiError, badRequest } from '../errors.js';
import { authenticate } from '../middleware/auth.js';
import { meter } from '../middleware/usage.js';
import { parseBbox } from '../util/geo.js';
import type { AppEnv } from '../util/http.js';

export function registerTransitRoutes(app: Hono<AppEnv>, deps: ServiceDeps): void {
  const auth = authenticate(deps);

  app.get('/v1/transit/stations', auth, meter(deps, 'transit'), async (c) => {
    const bbox = parseBbox(c.req.query('bbox'));
    if (!bbox) throw badRequest('"bbox" must be "west,south,east,north"');
    if (bbox[2] - bbox[0] > 2 || bbox[3] - bbox[1] > 2) throw badRequest('"bbox" must span at most 2 degrees in each direction');
    const stations = await deps.transit.stationsInBbox(bbox, TRANSIT_LIMITS.maxStations);
    return c.json({ stations });
  });

  app.get('/v1/transit/lines/:lineId', auth, meter(deps, 'transit'), async (c) => {
    const lineId = c.req.param('lineId');
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(lineId)) throw badRequest('Invalid line id');
    const line = await deps.transit.getLine(lineId);
    if (!line) throw new ApiError(404, 'NOT_FOUND', `Line "${lineId}" not found`);
    return c.json(line);
  });
}
