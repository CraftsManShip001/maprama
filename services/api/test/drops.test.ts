import { RARITIES, haversineMeters } from '@diorama/protocol';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createMemoryDeps } from '../src/adapters/memory/index.js';
import type { Campaign } from '../src/deps.js';
import { dropFromRef, generateCellDrops, nearbyDrops, parseDropId } from '../src/drops/generate.js';
import { generateApiKey } from '../src/util/crypto.js';
import { GANGNAM, SEONGSU, T0, campaignBody, createCampaign, createHarness, json, nearby } from './helpers/harness.js';

const campaign: Campaign = {
  id: 'cmpfixed01',
  appId: 'app1',
  seed: 'fixed-seed',
  channel: 'main',
  type: 'vinyl',
  rarityWeights: { common: 1, rare: 1, legendary: 1 },
  payloadPool: ['a', 'b', 'c'],
  area: { center: SEONGSU, radiusMeters: 1000 },
  density: 30,
  windowMinutes: 15,
  startsAt: new Date(T0 - 3_600_000).toISOString(),
  endsAt: new Date(T0 + 3_600_000).toISOString(),
  startsAtMs: T0 - 3_600_000,
  endsAtMs: T0 + 3_600_000,
  collectRadiusMeters: 25,
  createdAt: T0,
};

describe('deterministic drop generation', () => {
  it('yields identical drops for identical inputs', () => {
    const a = nearbyDrops(campaign, T0, SEONGSU, 600);
    const b = nearbyDrops(structuredClone(campaign), T0 + 60_000, SEONGSU, 600);
    expect(a.length).toBeGreaterThan(10);
    expect(b).toEqual(a);
  });

  it('changes drops in a different window or with a different seed', () => {
    const a = nearbyDrops(campaign, T0, SEONGSU, 600);
    const next = nearbyDrops(campaign, T0 + 15 * 60_000, SEONGSU, 600);
    const ids = new Set(a.map((d) => d.id));
    expect(next.length).toBeGreaterThan(0);
    expect(next.some((d) => ids.has(d.id))).toBe(false);
    expect(next.map((d) => d.coordinate)).not.toEqual(a.map((d) => d.coordinate));
    const reseeded = nearbyDrops({ ...campaign, seed: 'other' }, T0, SEONGSU, 600);
    expect(reseeded.map((d) => d.coordinate)).not.toEqual(a.map((d) => d.coordinate));
  });

  it('encodes campaign/window/cell/index in stable ids and regenerates from them', () => {
    const drops = nearbyDrops(campaign, T0, SEONGSU, 600);
    for (const d of drops) {
      const ref = parseDropId(d.id)!;
      expect(ref.campaignId).toBe(campaign.id);
      expect(ref.window).toBe(4);
      expect(ref.cell).toMatch(/^[0-9b-hjkmnp-z]{6}$/);
      expect(dropFromRef(campaign, ref)).toEqual(d);
      expect(haversineMeters(SEONGSU, d.coordinate)).toBeLessThanOrEqual(600);
      expect(RARITIES).toContain(d.rarity);
      expect(['a', 'b', 'c']).toContain(d.payload);
      expect(d.type).toBe('vinyl');
    }
    expect(new Set(drops.map((d) => d.rarity)).size).toBe(3);
    expect(parseDropId('d1.x.1')).toBeNull();
    expect(parseDropId('d2.cmp.1.wydm9q.0')).toBeNull();
  });

  it('respects the area and roughly the density', () => {
    const cells = new Set(nearbyDrops(campaign, T0, SEONGSU, 3000).map((d) => parseDropId(d.id)!.cell));
    const all = [...cells].flatMap((c) => generateCellDrops(campaign, 4, c));
    for (const d of all) expect(haversineMeters(SEONGSU, d.coordinate)).toBeLessThanOrEqual(1000);
    const expected = campaign.density * Math.PI * 1; // 1 km radius
    expect(all.length).toBeGreaterThan(expected * 0.6);
    expect(all.length).toBeLessThan(expected * 1.4);
  });

  it('is empty outside the campaign time range', () => {
    expect(nearbyDrops(campaign, campaign.startsAtMs - 1, SEONGSU, 600)).toEqual([]);
    expect(nearbyDrops(campaign, campaign.endsAtMs, SEONGSU, 600)).toEqual([]);
  });
});

describe('drops API', () => {
  it('creates campaigns without exposing the seed and validates bodies', async () => {
    const h = createHarness();
    const admin = await h.addKey({ role: 'admin' });
    const res = await h.request('/v1/drops/campaigns', { key: admin, method: 'POST', body: campaignBody() });
    expect(res.status).toBe(201);
    const body = await json<{ campaign: Record<string, unknown> }>(res);
    expect(body.campaign.id).toMatch(/^cmp[0-9a-f]{16}$/);
    expect(body.campaign).not.toHaveProperty('seed');
    expect(body.campaign).toMatchObject({ appId: 'app1', channel: 'main', density: 40 });

    for (const bad of [
      { density: -1 },
      { type: 'sword' },
      { area: { bbox: [127.1, 37.5, 127.0, 37.6] } },
      { endsAt: new Date(T0 - 7_200_000).toISOString() },
      { payloadPool: [] },
      { rarityWeights: { epic: 1 } },
      { windowMinutes: 1.5 },
    ]) {
      const r = await h.request('/v1/drops/campaigns', { key: admin, method: 'POST', body: campaignBody(bad) });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect((await json<{ error: { code: string } }>(r)).error.code).toBe('INVALID_REQUEST');
    }
    const invalidJson = await h.request('/v1/drops/campaigns', { key: admin, method: 'POST', body: '{nope' });
    expect((await json<{ error: { code: string } }>(invalidJson)).error.code).toBe('INVALID_JSON');
  });

  it('returns the same nearby drops for every client and a new set in the next window', async () => {
    const h = createHarness();
    const admin = await h.addKey({ role: 'admin' });
    const clientA = await h.addKey();
    const clientB = await h.addKey();
    await createCampaign(h, admin);

    const a = await nearby(h, clientA, SEONGSU);
    const b = await nearby(h, clientB, SEONGSU);
    expect(a.length).toBeGreaterThan(5);
    expect(b).toEqual(a);
    for (let i = 1; i < a.length; i++) {
      expect(haversineMeters(SEONGSU, a[i]!.coordinate)).toBeGreaterThanOrEqual(haversineMeters(SEONGSU, a[i - 1]!.coordinate));
    }

    const res = await h.request(`/v1/drops/nearby?lng=${SEONGSU.lng}&lat=${SEONGSU.lat}&channel=main`, { key: clientA });
    const { expiresAt } = await json<{ expiresAt: number }>(res);
    expect(expiresAt).toBe(T0 + 10 * 60_000);

    h.clock.advance(10 * 60_000);
    const later = await nearby(h, clientA, SEONGSU);
    expect(later.some((d) => a.some((x) => x.id === d.id))).toBe(false);
  });

  it('gives identical drops from separate service instances sharing the campaign record', async () => {
    const results = [];
    for (let i = 0; i < 2; i++) {
      const deps = createMemoryDeps({ clock: { now: () => T0, sleep: async () => {} } });
      await deps.drops.insertCampaign(campaign);
      const { key, keyHash } = await generateApiKey(globalThis.crypto);
      await deps.keys.insert({ id: 'k', keyHash, appId: 'app1', plan: 'pro', monthlyQuota: 1000, role: 'client', createdAt: T0 });
      const res = await createApp(deps).request(`/v1/drops/nearby?lng=${SEONGSU.lng}&lat=${SEONGSU.lat}&radius=400&channel=main`, {
        headers: { authorization: `Bearer ${key}` },
      });
      results.push(await res.json());
    }
    expect(results[1]).toEqual(results[0]);
  });

  it('isolates campaigns by app and channel', async () => {
    const h = createHarness();
    const admin = await h.addKey({ role: 'admin' });
    const otherApp = await h.addKey({ appId: 'app2' });
    await createCampaign(h, admin);
    expect(await nearby(h, otherApp, SEONGSU)).toEqual([]);
    expect(await nearby(h, admin, SEONGSU, 500, 'events')).toEqual([]);
    expect(await nearby(h, admin, GANGNAM, 500)).toEqual([]);
    expect((await h.request(`/v1/drops/nearby?lng=1&lat=1&radius=99999&channel=main`, { key: admin })).status).toBe(400);
    expect((await h.request(`/v1/drops/nearby?lng=1&lat=1`, { key: admin })).status).toBe(400);
  });
});
