import { readFileSync } from 'node:fs';
import { haversineMeters, validateWorldData, type WorldData } from '@maprama/protocol';
import { describe, expect, it } from 'vitest';
import { createKey } from '../scripts/create-key.js';
import { worldSeedSql } from '../scripts/seed-from-world.js';
import { D1KeysRepo, D1PlacesRepo, D1TransitRepo } from '../src/adapters/d1/repos.js';
import { inlineSql, placeUpsert, sqlLiteral } from '../src/adapters/d1/statements.js';
import { parseAddressDb } from '../src/seed/addresses.js';
import { lngLatToUtmk, utmkToLngLat } from '../src/seed/utmk.js';
import { seedFromWorld } from '../src/seed/world.js';
import { API_KEY_PATTERN, sha256Hex } from '../src/util/crypto.js';
import { createTestD1 } from './helpers/d1-shim.js';
import { SEONGSU } from './helpers/harness.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('UTM-K (EPSG:5179)', () => {
  it('maps the projection origin to the false easting/northing and round-trips', () => {
    const o = lngLatToUtmk(127.5, 38);
    expect(o.x).toBeCloseTo(1_000_000, 3);
    expect(o.y).toBeCloseTo(2_000_000, 3);
    for (const [lng, lat] of [
      [126.978, 37.5665],
      [129.0756, 35.1796],
      [126.5312, 33.4996],
    ] as const) {
      const p = lngLatToUtmk(lng, lat);
      const back = utmkToLngLat(p.x, p.y);
      expect(back.lng).toBeCloseTo(lng, 7);
      expect(back.lat).toBeCloseTo(lat, 7);
    }
    const cityHall = lngLatToUtmk(126.978, 37.5665);
    expect(cityHall.x).toBeGreaterThan(950_000);
    expect(cityHall.x).toBeLessThan(958_000);
    expect(cityHall.y).toBeGreaterThan(1_948_000);
    expect(cityHall.y).toBeLessThan(1_956_000);
  });
});

describe('address DB import', () => {
  it('parses the 5-row positional fixture', () => {
    const { places, skipped } = parseAddressDb(fixture('addresses-sample.txt'));
    expect(skipped).toEqual([]);
    expect(places).toHaveLength(5);
    expect(places[0]).toMatchObject({
      id: 'addr:112004103001-0-83-21',
      kind: 'address',
      name: '성수역 1번출구 빌딩',
      address: '서울특별시 성동구 왕십리로 83-21',
      category: '04781',
      source: 'juso',
    });
    expect(haversineMeters(places[0]!.coordinate, { lng: 127.05595, lat: 37.5446 })).toBeLessThan(0.5);
    expect(places[1]!.name).toBe('성수이로 113');
    expect(places[3]!.address).toBe('서울특별시 성동구 뚝섬로 지하 273');
  });

  it('supports a header row with columns in any order, CSV quoting and WGS84', () => {
    const csv = ['X좌표,Y좌표,도로명,시도명,시군구명,건물본번,건물명', '127.0559,37.5446,아차산로,서울특별시,성동구,1,"카페, 성수"', ',,빈좌표로,서울특별시,성동구,2,'].join('\n');
    const { places, skipped } = parseAddressDb(csv, { crs: 'EPSG:4326' });
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ name: '카페, 성수', address: '서울특별시 성동구 아차산로 1', coordinate: { lng: 127.0559, lat: 37.5446 } });
    expect(skipped).toEqual([{ line: 3, reason: 'missing coordinates' }]);
    expect(() => parseAddressDb('도로명,건물본번\n성수이로,1')).toThrow(/시도명/);
  });

  it('emits SQL that loads into D1 and powers reverse geocoding', async () => {
    const { d1, sqlite } = createTestD1();
    const { places } = parseAddressDb(fixture('addresses-sample.txt'));
    sqlite.exec(places.flatMap((p) => placeUpsert(p).map(inlineSql)).join('\n'));
    const repo = new D1PlacesRepo(d1);
    const hit = await repo.nearest({ lng: 127.05595, lat: 37.5448 }, 200, 'address');
    expect(hit?.place.name).toBe('성수역 1번출구 빌딩');
    expect(sqlLiteral("it's")).toBe("'it''s'");
  });
});

describe('world seed', () => {
  const world = JSON.parse(fixture('mini.world.json')) as WorldData;

  it('fixture is valid WorldData', () => {
    expect(validateWorldData(world)).toEqual({ ok: true });
  });

  it('converts POIs and stations from world units to lng/lat', () => {
    const { places, stations } = seedFromWorld(world, 'mini');
    expect(stations.map((s) => s.id)).toEqual(['st:mini:s1', 'st:mini:s2']);
    expect(stations[0]!.coordinate).toEqual(SEONGSU);
    // x = -80 units * 8 m = 640 m west
    expect(haversineMeters(stations[0]!.coordinate, stations[1]!.coordinate)).toBeGreaterThan(630);
    expect(haversineMeters(stations[0]!.coordinate, stations[1]!.coordinate)).toBeLessThan(650);
    expect(places.map((p) => [p.id, p.kind])).toEqual([
      ['poi:mini:p1', 'poi'],
      ['poi:mini:p2', 'poi'],
      ['station:mini:s1', 'station'],
      ['station:mini:s2', 'station'],
    ]);
  });

  it('seed SQL applies to D1 and is searchable', async () => {
    const { d1, sqlite } = createTestD1();
    sqlite.exec(worldSeedSql(world, 'mini'));
    const places = new D1PlacesRepo(d1);
    const found = await places.searchCandidates({ queryNorm: '서울숲', tokens: ['서울', '울숲'], prefix: false, limit: 10 });
    expect(found.map((p) => p.id)).toContain('poi:mini:p2');
    const stations = await new D1TransitRepo(d1).stationsInBbox([127.04, 37.54, 127.06, 37.55], 10);
    expect(stations.map((s) => s.name)).toEqual(['성수역', '뚝섬역']);
  });
});

describe('create-key script', () => {
  it('prints a key whose hash insert SQL works with the D1 keys repo', async () => {
    const { key, record, sql } = await createKey({ appId: 'app1', plan: 'pro', role: 'server', now: 1 });
    expect(key).toMatch(API_KEY_PATTERN);
    expect(sql).not.toContain(key);
    expect(record.monthlyQuota).toBe(2_000_000);
    const { d1, sqlite } = createTestD1();
    sqlite.exec(sql);
    const found = await new D1KeysRepo(d1).findByHash(await sha256Hex(globalThis.crypto, key));
    expect(found).toMatchObject({ appId: 'app1', plan: 'pro', role: 'server', createdAt: 1 });
  });
});
