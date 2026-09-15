import type { Hono } from 'hono';
import type { ServiceDeps } from '../deps.js';
import { ApiError, badRequest } from '../errors.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { deriveReceiptSecret, randomToken } from '../util/crypto.js';
import { readJson, type AppEnv } from '../util/http.js';
import { deliverWebhook, isAllowedWebhookUrl, newEventId } from '../webhooks/deliver.js';
import { jsonBodyLimit } from './drops.js';

export function registerWebhookRoutes(app: Hono<AppEnv>, deps: ServiceDeps): void {
  const auth = authenticate(deps);

  /** Per-app receipt secret for `verifyReceipt`; reading it never touches webhooks. */
  app.get('/v1/receipts/secret', auth, requireRole('admin'), async (c) => {
    const appId = c.get('apiKey').appId;
    c.header('Cache-Control', 'no-store');
    return c.json({ receiptSecret: await deriveReceiptSecret(deps.secrets.receiptSecret, appId) });
  });

  app.post('/v1/webhooks', auth, requireRole('admin'), jsonBodyLimit, async (c) => {
    const body = await readJson(c);
    const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const { url, rotateSecret } = fields;
    if (typeof url !== 'string' || url.length > 2048 || !isAllowedWebhookUrl(url, { allowInsecureLocalWebhooks: deps.options?.allowInsecureLocalWebhooks === true })) {
      throw badRequest('"url" must be an https URL on a public hostname (no IP literals, localhost or private names)');
    }
    if (rotateSecret !== undefined && typeof rotateSecret !== 'boolean') throw badRequest('"rotateSecret" must be a boolean');
    const appId = c.get('apiKey').appId;
    const now = deps.clock.now();
    const existing = await deps.webhooks.getEndpoint(appId);
    // The signing secret changes only for a new endpoint or on explicit request,
    // so updating the URL never breaks verification on the app server.
    const secretRotated = !existing || rotateSecret === true;
    const secret = existing && !secretRotated ? existing.secret : `whsec_${randomToken(deps.crypto, 32)}`;
    const endpoint = { appId, url, secret, createdAt: existing?.createdAt ?? now, updatedAt: now };
    await deps.webhooks.upsertEndpoint(endpoint);
    return c.json(
      {
        url: endpoint.url,
        secret: endpoint.secret,
        secretRotated,
        receiptSecret: await deriveReceiptSecret(deps.secrets.receiptSecret, appId),
        createdAt: endpoint.createdAt,
        updatedAt: endpoint.updatedAt,
      },
      201,
    );
  });

  app.post('/v1/webhooks/test', auth, requireRole('admin'), async (c) => {
    const appId = c.get('apiKey').appId;
    const endpoint = await deps.webhooks.getEndpoint(appId);
    if (!endpoint) throw new ApiError(404, 'WEBHOOK_NOT_CONFIGURED', 'No webhook endpoint is configured; POST /v1/webhooks first');
    const event = {
      id: newEventId(deps),
      type: 'webhook.test' as const,
      createdAt: deps.clock.now(),
      appId,
      data: { message: 'Test event from Diorama' },
    };
    const attempts = await deliverWebhook(deps, endpoint, event);
    return c.json({
      deliveryId: event.id,
      delivered: attempts.some((a) => a.ok),
      attempts: attempts.map(({ attempt, ok, responseStatus, error, attemptedAt }) => ({ attempt, ok, responseStatus, error, attemptedAt })),
    });
  });
}
