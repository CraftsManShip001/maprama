import { describe, expect, it } from 'vitest';
import { deriveReceiptSecret } from '../src/util/crypto.js';
import { verifyWebhookSignature } from '../src/verify.js';
import { isAllowedWebhookUrl } from '../src/webhooks/deliver.js';
import { RECEIPT_SECRET, createHarness, json } from './helpers/harness.js';

type TestJson = { deliveryId: string; delivered: boolean; attempts: { attempt: number; ok: boolean; responseStatus: number | null; error: string | null }[] };

async function withEndpoint() {
  const h = createHarness();
  const admin = await h.addKey({ role: 'admin' });
  const res = await h.request('/v1/webhooks', { key: admin, method: 'POST', body: { url: 'https://app.example/hooks' } });
  expect(res.status).toBe(201);
  const hook = await json<{ url: string; secret: string; receiptSecret: string }>(res);
  return { h, admin, hook };
}

describe('POST /v1/webhooks', () => {
  it('creates an endpoint with a signing secret and the app receipt secret', async () => {
    const { hook } = await withEndpoint();
    expect(hook.url).toBe('https://app.example/hooks');
    expect(hook.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect((hook as { secretRotated?: boolean }).secretRotated).toBe(true);
    expect(hook.receiptSecret).toBe(await deriveReceiptSecret(RECEIPT_SECRET, 'app1'));
  });

  it('keeps the signing secret when updating the URL, and rotates only with rotateSecret: true', async () => {
    const { h, admin, hook } = await withEndpoint();
    type HookJson = { url: string; secret: string; secretRotated: boolean };
    const updated = await json<HookJson>(await h.request('/v1/webhooks', { key: admin, method: 'POST', body: { url: 'https://app.example/hooks2' } }));
    expect(updated).toMatchObject({ url: 'https://app.example/hooks2', secret: hook.secret, secretRotated: false });
    expect(await h.deps.webhooks.getEndpoint('app1')).toMatchObject({ url: 'https://app.example/hooks2', secret: hook.secret });

    const same = await json<HookJson>(await h.request('/v1/webhooks', { key: admin, method: 'POST', body: { url: 'https://app.example/hooks2', rotateSecret: false } }));
    expect(same).toMatchObject({ secret: hook.secret, secretRotated: false });

    const rotated = await json<HookJson>(await h.request('/v1/webhooks', { key: admin, method: 'POST', body: { url: 'https://app.example/hooks3', rotateSecret: true } }));
    expect(rotated.secretRotated).toBe(true);
    expect(rotated.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(rotated.secret).not.toBe(hook.secret);
    expect((await h.deps.webhooks.getEndpoint('app1'))?.secret).toBe(rotated.secret);

    const bad = await h.request('/v1/webhooks', { key: admin, method: 'POST', body: { url: 'https://app.example/hooks3', rotateSecret: 'yes' } });
    expect(bad.status).toBe(400);
    expect((await h.deps.webhooks.getEndpoint('app1'))?.secret).toBe(rotated.secret);
  });

  it('rejects non-https, IP-literal, localhost and private-name URLs', async () => {
    const h = createHarness();
    const admin = await h.addKey({ role: 'admin' });
    for (const url of [
      'http://app.example/hook',
      'ftp://x',
      'not a url',
      'https://user:pw@app.example/',
      'http://localhost:3000/hook',
      'https://localhost/hook',
      'https://127.0.0.1/hook',
      'https://10.0.0.5/hook',
      'https://[::1]/hook',
      'https://printer.local/hook',
      'https://metadata.google.internal/hook',
    ]) {
      expect((await h.request('/v1/webhooks', { key: admin, method: 'POST', body: { url } })).status, url).toBe(400);
    }
    expect(await h.deps.webhooks.getEndpoint('app1')).toBeNull();
  });

  it('allows http://localhost only with allowInsecureLocalWebhooks (dev:local)', async () => {
    const h = createHarness({ options: { allowInsecureLocalWebhooks: true } });
    const admin = await h.addKey({ role: 'admin' });
    expect((await h.request('/v1/webhooks', { key: admin, method: 'POST', body: { url: 'http://localhost:3000/hook' } })).status).toBe(201);
    // Still no private networks other than loopback.
    expect((await h.request('/v1/webhooks', { key: admin, method: 'POST', body: { url: 'http://192.168.0.10/hook' } })).status).toBe(400);
    expect((await h.request('/v1/webhooks', { key: admin, method: 'POST', body: { url: 'http://app.example/hook' } })).status).toBe(400);
  });
});

describe('isAllowedWebhookUrl', () => {
  it('accepts public https hostnames', () => {
    for (const url of ['https://app.example/hooks', 'https://api.example.co.kr:8443/maprama?x=1', 'https://hooks.example.com./x']) {
      expect(isAllowedWebhookUrl(url), url).toBe(true);
    }
  });

  it('rejects IPv4/IPv6 literals, including normalized numeric and IPv4-mapped forms', () => {
    for (const url of [
      'https://127.0.0.1/',
      'https://127.1/',
      'https://2130706433/',
      'https://0x7f.0.0.1/',
      'https://10.1.2.3/',
      'https://172.16.0.1/',
      'https://192.168.1.1/',
      'https://169.254.169.254/latest/meta-data',
      'https://100.64.0.1/',
      'https://8.8.8.8/',
      'https://[::1]/',
      'https://[fe80::1]/',
      'https://[fd00::1]/',
      'https://[::ffff:127.0.0.1]/',
      'https://[2001:db8::1]:8443/',
    ]) {
      expect(isAllowedWebhookUrl(url), url).toBe(false);
    }
  });

  it('rejects localhost, *.local, *.internal, other private names and single-label hosts', () => {
    for (const url of [
      'https://localhost/',
      'https://LOCALHOST./',
      'https://api.localhost/',
      'https://printer.local/',
      'https://metadata.google.internal/',
      'https://box.localdomain/',
      'https://nas.home.arpa/',
      'https://intranet/',
    ]) {
      expect(isAllowedWebhookUrl(url), url).toBe(false);
    }
  });

  it('re-allows only loopback hosts over http(s) with allowInsecureLocalWebhooks', () => {
    const dev = { allowInsecureLocalWebhooks: true };
    for (const url of ['http://localhost:3000/hook', 'http://127.0.0.1:3000/hook', 'http://[::1]:3000/hook', 'https://localhost/hook']) {
      expect(isAllowedWebhookUrl(url), url).toBe(false);
      expect(isAllowedWebhookUrl(url, dev), url).toBe(true);
    }
    for (const url of ['http://10.0.0.1/', 'http://printer.local/', 'http://app.example/', 'ftp://localhost/']) {
      expect(isAllowedWebhookUrl(url, dev), url).toBe(false);
    }
  });
});

describe('GET /v1/receipts/secret', () => {
  it('returns the per-app receipt secret to admin keys without touching webhooks', async () => {
    const { h, admin, hook } = await withEndpoint();
    const res = await h.request('/v1/receipts/secret', { key: admin });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await json(res)).toEqual({ receiptSecret: await deriveReceiptSecret(RECEIPT_SECRET, 'app1') });
    expect((await h.deps.webhooks.getEndpoint('app1'))?.secret).toBe(hook.secret);
  });

  it('works without a webhook endpoint and is scoped to the key app', async () => {
    const h = createHarness();
    const admin2 = await h.addKey({ role: 'admin', appId: 'app2' });
    const res = await h.request('/v1/receipts/secret', { key: admin2 });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ receiptSecret: await deriveReceiptSecret(RECEIPT_SECRET, 'app2') });
    expect(await h.deps.webhooks.getEndpoint('app2')).toBeNull();
  });

  it('requires an admin key', async () => {
    const h = createHarness();
    expect((await h.request('/v1/receipts/secret')).status).toBe(401);
    for (const role of ['client', 'server'] as const) {
      const res = await h.request('/v1/receipts/secret', { key: await h.addKey({ role }) });
      expect(res.status, role).toBe(403);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe('FORBIDDEN_ROLE');
    }
  });
});

describe('POST /v1/webhooks/test and delivery retries', () => {
  it('404s when no endpoint is configured', async () => {
    const h = createHarness();
    const admin = await h.addKey({ role: 'admin' });
    const res = await h.request('/v1/webhooks/test', { key: admin, method: 'POST' });
    expect(res.status).toBe(404);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('WEBHOOK_NOT_CONFIGURED');
  });

  it('retries with backoff and records every attempt', async () => {
    const { h, admin, hook } = await withEndpoint();
    h.fetchResponses.push(
      () => new Response('down', { status: 500 }),
      () => {
        throw new TypeError('network unreachable');
      },
      () => new Response(null, { status: 204 }),
    );
    const res = await json<TestJson>(await h.request('/v1/webhooks/test', { key: admin, method: 'POST' }));
    expect(res.delivered).toBe(true);
    expect(res.attempts.map((a) => [a.attempt, a.ok, a.responseStatus])).toEqual([
      [1, false, 500],
      [2, false, null],
      [3, true, 204],
    ]);
    expect(res.attempts[1]!.error).toContain('network unreachable');
    expect(h.clock.sleeps).toEqual([1000, 4000]);

    const recorded = await h.deps.webhooks.listAttempts('app1', res.deliveryId);
    expect(recorded.map((a) => a.ok)).toEqual([false, false, true]);
    expect(recorded.every((a) => a.eventType === 'webhook.test' && a.url === hook.url)).toBe(true);

    // Each attempt is freshly signed and verifiable.
    for (const call of h.fetchCalls) {
      expect(call.headers.get('Maprama-Event')).toBe('webhook.test');
      expect(call.headers.get('Maprama-Delivery')).toBe(res.deliveryId);
      const v = await verifyWebhookSignature(call.body, call.headers.get('Maprama-Signature'), hook.secret, 300, h.clock.now() / 1000);
      expect(v.ok).toBe(true);
    }
  });

  it('gives up after 3 failed attempts', async () => {
    const { h, admin } = await withEndpoint();
    for (let i = 0; i < 3; i++) h.fetchResponses.push(() => new Response('no', { status: 503 }));
    const res = await json<TestJson>(await h.request('/v1/webhooks/test', { key: admin, method: 'POST' }));
    expect(res.delivered).toBe(false);
    expect(res.attempts).toHaveLength(3);
    expect(h.fetchCalls).toHaveLength(3);
    expect(await h.deps.webhooks.listAttempts('app1')).toHaveLength(3);
  });

  it('stops after the first success', async () => {
    const { h, admin } = await withEndpoint();
    const res = await json<TestJson>(await h.request('/v1/webhooks/test', { key: admin, method: 'POST' }));
    expect(res.attempts).toHaveLength(1);
    expect(h.clock.sleeps).toEqual([]);
  });
});
