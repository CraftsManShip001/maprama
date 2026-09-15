import { afterEach, describe, expect, it, vi } from 'vitest';
import { BLOB_KEYS } from '../src/config.js';
import { campaignBody, createHarness, json } from './helpers/harness.js';

type ErrorJson = { error: { code: string; message: string } };

describe('authentication', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects a missing key with 401 MISSING_KEY', async () => {
    const h = createHarness();
    const res = await h.request('/v1/search?q=성수');
    expect(res.status).toBe(401);
    expect(await json<ErrorJson>(res)).toEqual({ error: { code: 'MISSING_KEY', message: expect.any(String) } });
  });

  it('rejects unknown, malformed and revoked keys with 401 INVALID_KEY', async () => {
    const h = createHarness();
    const unknown = `dio_${'A'.repeat(43)}`;
    expect((await json<ErrorJson>(await h.request('/v1/search?q=a', { key: unknown }))).error.code).toBe('INVALID_KEY');
    expect((await json<ErrorJson>(await h.request('/v1/search?q=a', { key: 'not-a-key' }))).error.code).toBe('INVALID_KEY');
    const revoked = await h.addKey({ revoked: true });
    const res = await h.request('/v1/search?q=a', { key: revoked });
    expect(res.status).toBe(401);
    expect((await json<ErrorJson>(res)).error.code).toBe('INVALID_KEY');
  });

  it('rejects a non-Bearer Authorization header', async () => {
    const h = createHarness();
    const res = await h.app.request('/v1/search?q=a', { headers: { authorization: 'Basic abc' } });
    expect(res.status).toBe(401);
    expect((await json<ErrorJson>(res)).error.code).toBe('MALFORMED_AUTHORIZATION');
  });

  it('accepts ?key= only on tile/world GETs', async () => {
    const h = createHarness();
    const key = await h.addKey();
    await h.deps.blobs.put(BLOB_KEYS.world('seongsu'), '{"version":1}', 'application/json');
    const search = await h.app.request(`/v1/search?q=a&key=${key}`);
    expect(search.status).toBe(401);
    expect((await json<ErrorJson>(search)).error.code).toBe('QUERY_KEY_NOT_ALLOWED');
    const world = await h.app.request(`/v1/worlds/seongsu.json?key=${key}`);
    expect(world.status).toBe(200);
  });

  it('accepts a valid Bearer key', async () => {
    const h = createHarness();
    const key = await h.addKey();
    const res = await h.request('/v1/search?q=성수', { key });
    expect(res.status).toBe(200);
  });

  it('enforces roles: campaigns need admin/server, webhooks need admin', async () => {
    const h = createHarness();
    const client = await h.addKey({ role: 'client' });
    const server = await h.addKey({ role: 'server' });
    const admin = await h.addKey({ role: 'admin' });

    const asClient = await h.request('/v1/drops/campaigns', { key: client, method: 'POST', body: campaignBody() });
    expect(asClient.status).toBe(403);
    expect((await json<ErrorJson>(asClient)).error.code).toBe('FORBIDDEN_ROLE');
    expect((await h.request('/v1/drops/campaigns', { key: server, method: 'POST', body: campaignBody() })).status).toBe(201);
    expect((await h.request('/v1/drops/campaigns', { key: admin, method: 'POST', body: campaignBody() })).status).toBe(201);

    const hook = { url: 'https://example.com/hooks/diorama' };
    expect((await h.request('/v1/webhooks', { key: client, method: 'POST', body: hook })).status).toBe(403);
    expect((await h.request('/v1/webhooks', { key: server, method: 'POST', body: hook })).status).toBe(403);
    expect((await h.request('/v1/webhooks', { key: admin, method: 'POST', body: hook })).status).toBe(201);
    expect((await h.request('/v1/webhooks/test', { key: server, method: 'POST' })).status).toBe(403);
  });

  it('never logs raw keys, even when a handler fails', async () => {
    const logs: string[] = [];
    for (const m of ['log', 'error', 'warn', 'info'] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      });
    }
    const h = createHarness();
    const key = await h.addKey();
    h.deps.places.searchCandidates = async () => {
      throw new Error('storage down');
    };
    const res = await h.request('/v1/search?q=성수', { key });
    expect(res.status).toBe(500);
    expect((await json<ErrorJson>(res)).error.code).toBe('INTERNAL_ERROR');
    await h.app.request(`/v1/worlds/nope.json?key=${key}`);
    expect(logs.join('\n')).not.toContain(key);
    expect(logs.join('\n')).not.toContain(key.slice(4));
  });

  it('returns JSON 404 for unknown routes', async () => {
    const h = createHarness();
    const res = await h.request('/v1/nope');
    expect(res.status).toBe(404);
    expect((await json<ErrorJson>(res)).error.code).toBe('NOT_FOUND');
  });
});
