import type { DropSpec } from '@maprama/protocol';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { DROP_LIMITS, MAX_BODY_BYTES } from '../config.js';
import type { Campaign, ServiceDeps } from '../deps.js';
import { CHANNEL_RE, parseCampaignSpec } from '../drops/campaign.js';
import { parseCollectInput, verifyCollect } from '../drops/collect.js';
import { currentWindow, nearbyDrops, windowRange } from '../drops/generate.js';
import { badRequest, errorBody } from '../errors.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { meter } from '../middleware/usage.js';
import { randomHex } from '../util/crypto.js';
import { defer, numberParam, readJson, type AppEnv } from '../util/http.js';
import { deliverWebhook, newEventId } from '../webhooks/deliver.js';
import { haversineMeters } from '@maprama/protocol';

export const jsonBodyLimit = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) => c.json(errorBody('PAYLOAD_TOO_LARGE', `Request body exceeds ${MAX_BODY_BYTES} bytes`), 413),
});

/** Campaign as returned by the API (never includes the PRNG seed). */
export function publicCampaign(c: Campaign): Omit<Campaign, 'seed' | 'startsAtMs' | 'endsAtMs'> {
  const { seed: _seed, startsAtMs: _s, endsAtMs: _e, ...rest } = c;
  return rest;
}

export function registerDropRoutes(app: Hono<AppEnv>, deps: ServiceDeps): void {
  const auth = authenticate(deps);

  app.post('/v1/drops/campaigns', auth, requireRole('admin', 'server'), jsonBodyLimit, async (c) => {
    const spec = parseCampaignSpec(await readJson(c));
    const key = c.get('apiKey');
    const campaign: Campaign = {
      ...spec,
      id: `cmp${randomHex(deps.crypto, 8)}`,
      appId: key.appId,
      seed: randomHex(deps.crypto, 16),
      createdAt: deps.clock.now(),
    };
    await deps.drops.insertCampaign(campaign);
    return c.json({ campaign: publicCampaign(campaign) }, 201);
  });

  app.get('/v1/drops/nearby', auth, meter(deps, 'drops'), async (c) => {
    const lng = numberParam(c.req.query('lng'), 'lng', { min: -180, max: 180 });
    const lat = numberParam(c.req.query('lat'), 'lat', { min: -90, max: 90 });
    const radius = numberParam(c.req.query('radius'), 'radius', {
      min: 1,
      max: DROP_LIMITS.maxNearbyRadiusMeters,
      fallback: DROP_LIMITS.defaultNearbyRadiusMeters,
    });
    const channel = c.req.query('channel');
    if (!channel || !CHANNEL_RE.test(channel)) throw badRequest('"channel" is required');
    const now = deps.clock.now();
    const center = { lng, lat };
    const campaigns = await deps.drops.campaignsOverlapping(c.get('apiKey').appId, channel, now, now);
    const drops: DropSpec[] = [];
    let expiresAt: number | null = null;
    for (const campaign of campaigns) {
      const w = currentWindow(campaign, now);
      if (w === null) continue;
      const end = windowRange(campaign, w)[1];
      expiresAt = expiresAt === null ? end : Math.min(expiresAt, end);
      drops.push(...nearbyDrops(campaign, now, center, radius));
    }
    drops.sort((a, b) => haversineMeters(center, a.coordinate) - haversineMeters(center, b.coordinate));
    return c.json({ drops: drops.slice(0, 1000), generatedAt: now, expiresAt });
  });

  app.post('/v1/drops/collect', auth, meter(deps, 'collect'), jsonBodyLimit, async (c) => {
    const input = parseCollectInput(await readJson(c));
    const appId = c.get('apiKey').appId;
    const outcome = await verifyCollect(deps, appId, input);
    if (!outcome.ok) return c.json(errorBody(outcome.code, outcome.message), outcome.status);
    const { record, claims, replayed } = outcome;
    if (!replayed && claims) {
      const event = {
        id: newEventId(deps),
        type: 'drop.collected' as const,
        createdAt: record.collectedAt,
        appId,
        data: {
          receipt: record.receipt,
          dropId: claims.dropId,
          collectId: claims.collectId,
          userId: claims.userId,
          collectedAt: claims.collectedAt,
          payload: claims.payload,
          ...(claims.type ? { type: claims.type } : {}),
          ...(claims.rarity ? { rarity: claims.rarity } : {}),
        },
      };
      defer(
        deps,
        c,
        (async () => {
          const endpoint = await deps.webhooks.getEndpoint(appId);
          if (endpoint) await deliverWebhook(deps, endpoint, event);
        })(),
      );
    }
    return c.json({
      receipt: record.receipt,
      replayed,
      collect: { dropId: record.dropId, collectId: record.collectId, userId: record.userId, collectedAt: record.collectedAt },
    });
  });
}
