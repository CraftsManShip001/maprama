import { describe, expect, it } from 'vitest';
import { createD1Repos } from '../src/adapters/d1/repos.js';
import { createMemoryDeps } from '../src/adapters/memory/index.js';
import type { Campaign, CollectRecord, DropsRepo, KeysRepo, PlacesRepo, TransitRepo, UsageRepo, WebhooksRepo } from '../src/deps.js';
import { bigrams, normalizeText } from '../src/search/normalize.js';
import { createTestD1 } from './helpers/d1-shim.js';
import { GANGNAM, SEONGSU, T0, createCampaign, createHarness, json, nearby, north } from './helpers/harness.js';

type Repos = { keys: KeysRepo; usage: UsageRepo; places: PlacesRepo; transit: TransitRepo; drops: DropsRepo; webhooks: WebhooksRepo };

const factories: [string, () => Repos][] = [
  ['memory', () => createMemoryDeps()],
  ['d1 (node:sqlite)', () => createD1Repos(createTestD1().d1)],
];

describe('migration', () => {
  it('applies to SQLite and creates every table, including FTS5', () => {
    const { sqlite } = createTestD1();
    const names = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    for (const t of [
      'api_keys',
      'usage_counters',
      'places',
      'places_fts',
      'transit_stations',
      'transit_lines',
      'transit_line_stations',
      'drop_campaigns',
      'drop_collects',
      'webhook_endpoints',
      'webhook_deliveries',
    ]) {
      expect(names).toContain(t);
    }
  });
});

const q = (text: string, extra: { near?: { lng: number; lat: number }; limit?: number } = {}) => {
  const queryNorm = normalizeText(text);
  const chars = Array.from(queryNorm);
  return { queryNorm, tokens: chars.length === 1 ? chars : bigrams(queryNorm), prefix: chars.length === 1, limit: extra.limit ?? 50, ...(extra.near ? { near: extra.near } : {}) };
};

const baseCampaign: Campaign = {
  id: 'cmp1',
  appId: 'app1',
  seed: 's',
  channel: 'main',
  type: 'coin',
  rarityWeights: { common: 1 },
  payloadPool: [{ coins: 1 }],
  area: { center: SEONGSU, radiusMeters: 500 },
  density: 10,
  windowMinutes: 10,
  startsAt: new Date(T0).toISOString(),
  endsAt: new Date(T0 + 3_600_000).toISOString(),
  startsAtMs: T0,
  endsAtMs: T0 + 3_600_000,
  collectRadiusMeters: 20,
  createdAt: T0,
};

const collectRecord = (over: Partial<CollectRecord> = {}): CollectRecord => ({
  appId: 'app1',
  collectId: 'c-00000001',
  dropId: 'd1.cmp1.0.wydm9q.0',
  userId: 'u1',
  fix: { lng: 127.05, lat: 37.54, accuracyMeters: 4.5, timestamp: T0 },
  collectedAt: T0,
  receipt: 'r.s',
  ...over,
});

describe.each(factories)('%s repositories', (_name, make) => {
  it('keys', async () => {
    const r = make();
    const rec = { id: 'k1', keyHash: 'a'.repeat(64), appId: 'app1', plan: 'pro' as const, monthlyQuota: 10, role: 'server' as const, label: null, createdAt: T0, revokedAt: null };
    await r.keys.insert(rec);
    expect(await r.keys.findByHash('a'.repeat(64))).toEqual(rec);
    expect(await r.keys.findByHash('b'.repeat(64))).toBeNull();
  });

  it('usage', async () => {
    const r = make();
    await r.usage.record({ keyId: 'k1', month: '2026-09', unit: 'tile', units: 1, overageUnits: 0 });
    await r.usage.record({ keyId: 'k1', month: '2026-09', unit: 'tile', units: 1, overageUnits: 1 });
    await r.usage.record({ keyId: 'k1', month: '2026-09', unit: 'search', units: 5, overageUnits: 5 });
    await r.usage.record({ keyId: 'k1', month: '2026-10', unit: 'search', units: 5, overageUnits: 0 });
    expect(await r.usage.monthTotal('k1', '2026-09')).toBe(7);
    expect(await r.usage.monthTotal('k2', '2026-09')).toBe(0);
    const lines = (await r.usage.breakdown('k1', '2026-09')).sort((a, b) => a.unit.localeCompare(b.unit));
    expect(lines).toEqual([
      { unit: 'search', requests: 1, units: 5, overageUnits: 5 },
      { unit: 'tile', requests: 2, units: 2, overageUnits: 1 },
    ]);
  });

  it('places: n-gram/prefix index, re-index on update, local-first near, nearest', async () => {
    const r = make();
    await r.places.upsert([
      { id: 'p1', kind: 'poi', name: '스타벅스 성수역점', coordinate: SEONGSU, category: 'cafe', address: null, source: 'osm' },
      { id: 'p2', kind: 'poi', name: '스타벅스 강남역점', coordinate: GANGNAM, category: 'cafe', address: null, source: 'osm' },
      { id: 'a1', kind: 'address', name: '왕십리로 83', address: '서울특별시 성동구 왕십리로 83', coordinate: north(SEONGSU, 30), source: 'juso' },
    ]);
    expect((await r.places.searchCandidates(q('스타벅스'))).map((p) => p.id).sort()).toEqual(['p1', 'p2']);
    expect((await r.places.searchCandidates(q('성동구'))).map((p) => p.id)).toEqual(['a1']);
    expect((await r.places.searchCandidates(q('왕'))).map((p) => p.id)).toEqual(['a1']);
    expect((await r.places.searchCandidates(q('스타벅스', { near: GANGNAM, limit: 1 }))).map((p) => p.id)).toContain('p2');

    await r.places.upsert([{ id: 'p1', kind: 'poi', name: '블루보틀 성수', coordinate: SEONGSU, category: 'cafe', address: null, source: 'osm' }]);
    expect((await r.places.searchCandidates(q('스타벅스'))).map((p) => p.id)).toEqual(['p2']);
    expect((await r.places.searchCandidates(q('블루보틀'))).map((p) => p.id)).toEqual(['p1']);

    const hit = await r.places.nearest(SEONGSU, 200, 'address');
    expect(hit?.place.id).toBe('a1');
    expect(hit!.distanceMeters).toBeCloseTo(30, 0);
    expect(await r.places.nearest(SEONGSU, 20, 'address')).toBeNull();
    expect((await r.places.nearest(SEONGSU, 200, 'poi'))?.place.id).toBe('p1');
  });

  it('transit', async () => {
    const r = make();
    await r.transit.upsertStations([
      { id: 's1', name: 'A', coordinate: SEONGSU },
      { id: 's2', name: 'B', coordinate: north(SEONGSU, 500) },
      { id: 's3', name: 'C', coordinate: GANGNAM },
    ]);
    await r.transit.upsertLine({ id: 'L1', name: 'Line 1', color: '#123456', stationIds: ['s3', 's1', 's2'] });
    await r.transit.upsertLine({ id: 'L0', name: 'Line 0', color: '#000000', stationIds: ['s1'] });
    expect(await r.transit.getLine('L1')).toEqual({
      id: 'L1',
      name: 'Line 1',
      color: '#123456',
      stations: [
        { id: 's3', name: 'C', coordinate: GANGNAM, lineIds: ['L1'] },
        { id: 's1', name: 'A', coordinate: SEONGSU, lineIds: ['L0', 'L1'] },
        { id: 's2', name: 'B', coordinate: north(SEONGSU, 500), lineIds: ['L1'] },
      ],
    });
    await r.transit.upsertLine({ id: 'L1', name: 'Line 1', color: '#123456', stationIds: ['s2', 's1'] });
    expect((await r.transit.getLine('L1'))!.stations.map((s) => s.id)).toEqual(['s2', 's1']);
    expect((await r.transit.stationsInBbox([127.05, 37.54, 127.06, 37.56], 10)).map((s) => s.id)).toEqual(['s1', 's2']);
    expect(await r.transit.getLine('nope')).toBeNull();
  });

  it('drops', async () => {
    const r = make();
    await r.drops.insertCampaign(baseCampaign);
    expect(await r.drops.getCampaign('app1', 'cmp1')).toEqual(baseCampaign);
    expect(await r.drops.getCampaign('app2', 'cmp1')).toBeNull();
    expect((await r.drops.campaignsOverlapping('app1', 'main', T0 + 1, T0 + 1)).map((c) => c.id)).toEqual(['cmp1']);
    expect(await r.drops.campaignsOverlapping('app1', 'main', T0 + 3_600_000, T0 + 3_600_000)).toEqual([]);
    expect(await r.drops.campaignsOverlapping('app1', 'other', T0 + 1, T0 + 1)).toEqual([]);

    expect(await r.drops.insertCollect(collectRecord())).toBe('ok');
    expect(await r.drops.insertCollect(collectRecord({ dropId: 'd1.cmp1.0.wydm9q.1' }))).toBe('duplicate_collect_id');
    expect(await r.drops.insertCollect(collectRecord({ collectId: 'c-00000002' }))).toBe('duplicate_user_drop');
    expect(await r.drops.insertCollect(collectRecord({ collectId: 'c-00000003', dropId: 'd1.cmp1.0.wydm9q.2', collectedAt: T0 + 5 }))).toBe('ok');
    expect(await r.drops.findCollect('app1', 'c-00000001')).toEqual(collectRecord());
    expect(await r.drops.findCollect('app2', 'c-00000001')).toBeNull();
    expect(await r.drops.hasUserCollected('app1', 'u1', 'd1.cmp1.0.wydm9q.0')).toBe(true);
    expect(await r.drops.hasUserCollected('app1', 'u2', 'd1.cmp1.0.wydm9q.0')).toBe(false);
    expect((await r.drops.lastCollect('app1', 'u1'))?.collectId).toBe('c-00000003');
  });

  it('webhooks', async () => {
    const r = make();
    await r.webhooks.upsertEndpoint({ appId: 'app1', url: 'https://a', secret: 's1', createdAt: T0, updatedAt: T0 });
    await r.webhooks.upsertEndpoint({ appId: 'app1', url: 'https://b', secret: 's2', createdAt: T0 + 9, updatedAt: T0 + 9 });
    expect(await r.webhooks.getEndpoint('app1')).toEqual({ appId: 'app1', url: 'https://b', secret: 's2', createdAt: T0, updatedAt: T0 + 9 });
    const attempt = { deliveryId: 'evt1', attempt: 1, appId: 'app1', eventType: 'webhook.test', url: 'https://b', ok: false, responseStatus: 500, error: 'HTTP 500', attemptedAt: T0 };
    await r.webhooks.recordAttempt(attempt);
    await r.webhooks.recordAttempt({ ...attempt, attempt: 2, ok: true, responseStatus: 200, error: null, attemptedAt: T0 + 1 });
    expect((await r.webhooks.listAttempts('app1', 'evt1')).map((a) => [a.attempt, a.ok])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(await r.webhooks.listAttempts('app2')).toEqual([]);
  });
});

describe('full app over D1 repositories', () => {
  it('serves search and verifies collects end-to-end', async () => {
    const { d1 } = createTestD1();
    const h = createHarness({ override: createD1Repos(d1) });
    const admin = await h.addKey({ role: 'admin' });
    const client = await h.addKey({ plan: 'free', quota: 10_000 });
    await h.appDeps.places.upsert([{ id: 'p1', kind: 'poi', name: '성수역', coordinate: SEONGSU, category: 'subway' }]);
    const search = await json<{ results: { id: string }[] }>(await h.request('/v1/search?q=성수', { key: client }));
    expect(search.results.map((r) => r.id)).toEqual(['p1']);

    await createCampaign(h, admin);
    const drops = await nearby(h, client, SEONGSU);
    const body = {
      dropId: drops[0]!.id,
      collectId: 'd1-collect-0001',
      userId: 'u1',
      fix: { ...drops[0]!.coordinate, accuracyMeters: 3, timestamp: h.clock.now() },
    };
    const first = await h.request('/v1/drops/collect', { key: client, method: 'POST', body });
    expect(first.status).toBe(200);
    const replay = await h.request('/v1/drops/collect', { key: client, method: 'POST', body });
    expect((await json<{ receipt: string }>(replay)).receipt).toBe((await json<{ receipt: string }>(first)).receipt);
    const dup = await h.request('/v1/drops/collect', { key: client, method: 'POST', body: { ...body, collectId: 'd1-collect-0002' } });
    expect((await json<{ error: { code: string } }>(dup)).error.code).toBe('ALREADY_COLLECTED');

    const usage = await json<{ usedUnits: number }>(await h.request('/v1/usage', { key: client }));
    expect(usage.usedUnits).toBe(5 + 2 + 10 * 3);
  });
});
