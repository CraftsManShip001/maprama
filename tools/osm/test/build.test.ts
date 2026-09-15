import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateWorldData, type WorldData } from '@diorama/protocol';
import { OSM_ATTRIBUTION, KR_ATTRIBUTION, buildWorld, buildWorldWithStats, stringifyWorld } from '../src/build.js';
import { signedArea } from '../src/geometry.js';
import type { OverpassResponse } from '../src/types.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
const raw = fixture('basic.overpass.json') as OverpassResponse;
const kr = fixture('kr-buildings.geojson');

const byId = <T extends { id: string }>(items: T[], id: string): T => {
  const found = items.find((i) => i.id === id);
  if (!found) throw new Error(`missing ${id} in ${items.map((i) => i.id).join(',')}`);
  return found;
};

function expectInsideBounds(world: WorldData, x: number, z: number): void {
  const eps = 1e-6;
  expect(x).toBeGreaterThanOrEqual(world.bounds.minX - eps);
  expect(x).toBeLessThanOrEqual(world.bounds.maxX + eps);
  expect(z).toBeGreaterThanOrEqual(world.bounds.minZ - eps);
  expect(z).toBeLessThanOrEqual(world.bounds.maxZ + eps);
}

describe('buildWorld (fixture)', () => {
  const { world, stats } = buildWorldWithStats(raw, { name: 'Fixture' });

  it('produces valid WorldData centred on the bbox', () => {
    expect(validateWorldData(world)).toEqual({ ok: true });
    expect(world.unitMeters).toBe(8);
    expect(world.origin.lat).toBeCloseTo(37.544, 5);
    expect(world.origin.lng).toBeCloseTo(127.056, 5);
    expect(world.bounds.minX).toBeCloseTo(-12.5, 1);
    expect(world.bounds.maxX).toBeCloseTo(12.5, 1);
    expect(world.bounds.minZ).toBeCloseTo(-10, 1);
    expect(world.bounds.maxZ).toBeCloseTo(10, 1);
    expect(world.attribution).toEqual([OSM_ATTRIBUTION]);
  });

  it('keeps buildings, drops outside/unclosed ones and deduplicates geometry', () => {
    expect(world.buildings.map((b) => b.id).sort()).toEqual(['r40', 'w1', 'w2', 'w3', 'w4', 'w5', 'w8', 'w9']);
    expect(stats.duplicateBuildings).toBe(1);
  });

  it('writes counter-clockwise, open footprints inside the bbox', () => {
    for (const b of world.buildings) {
      expect(signedArea(b.footprint)).toBeGreaterThan(0);
      expect(b.footprint[0]).not.toEqual(b.footprint[b.footprint.length - 1]);
      for (const [x, z] of b.footprint) expectInsideBounds(world, x, z);
    }
  });

  it('clips a building crossing the bbox edge', () => {
    const edge = byId(world.buildings, 'w5');
    const xs = edge.footprint.map((p) => p[0]);
    expect(Math.max(...xs)).toBeCloseTo(world.bounds.maxX, 1);
    expect(Math.min(...xs)).toBeCloseTo(90 / 8, 1);
  });

  it('assembles multipolygon building relations', () => {
    const office = byId(world.buildings, 'r40');
    expect(office.name).toBe('Office Complex');
    expect(office.kind).toBe('office');
    expect(Math.abs(signedArea(office.footprint))).toBeCloseTo((15 * 15) / 64, 1);
  });

  it('applies height rules and facade kinds (world units = m / 8)', () => {
    expect(byId(world.buildings, 'w1')).toMatchObject({ height: 45 / 8, kind: 'apartment', name: '성수아파트' });
    expect(byId(world.buildings, 'w2')).toMatchObject({ height: 75 / 8, kind: 'glass' });
    expect(byId(world.buildings, 'w3')).toMatchObject({ height: 2, levels: 5, kind: 'office' });
    expect(byId(world.buildings, 'w4')).toMatchObject({ height: 9 / 8, kind: 'brick' });
    expect(byId(world.buildings, 'w5')).toMatchObject({ height: 7 / 8, kind: 'brick' });
    expect(byId(world.buildings, 'w8')).toMatchObject({ height: 1.2, levels: 3, kind: 'glass' });
    expect(byId(world.buildings, 'w9')).toMatchObject({ height: 15 / 8, kind: 'brick' });
    expect(stats.heightSources).toMatchObject({ height: 2, levels: 2, heuristic: 4 });
  });

  it('classifies and clips roads', () => {
    const ids = world.roads.map((r) => r.id).sort();
    expect(ids).toEqual(['w10', 'w11', 'w12', 'w13', 'w14', 'w16', 'w17_0', 'w17_1']);
    expect(byId(world.roads, 'w10')).toMatchObject({ cls: 'arterial', name: '성수이로' });
    expect(byId(world.roads, 'w10').pts).toHaveLength(2);
    expect(byId(world.roads, 'w11')).toMatchObject({ cls: 'local', name: '연무장길' });
    expect(byId(world.roads, 'w12').cls).toBe('alley');
    expect(byId(world.roads, 'w13').cls).toBe('alley');
    expect(byId(world.roads, 'w14').cls).toBe('local');
    expect(byId(world.roads, 'w16')).toMatchObject({ cls: 'arterial', bridge: true, name: '성수대교' });
    expect(byId(world.roads, 'w12').bridge).toBeUndefined();
    for (const road of world.roads) for (const [x, z] of road.pts) expectInsideBounds(world, x, z);
  });

  it('can include sidewalks', () => {
    const withSidewalks = buildWorld(raw, { name: 'Fixture', includeSidewalks: true });
    expect(byId(withSidewalks.roads, 'w18').cls).toBe('alley');
  });

  it('builds water from a multipolygon relation, clipped, with a water district label', () => {
    expect(world.water).toHaveLength(1);
    const river = world.water[0]!;
    expect(signedArea(river)).toBeGreaterThan(0);
    for (const [x, z] of river) expectInsideBounds(world, x, z);
    expect(Math.max(...river.map((p) => p[1]))).toBeCloseTo(world.bounds.maxZ, 1);
    const label = world.districts.find((d) => d.name === '한강');
    expect(label?.water).toBe(true);
  });

  it('builds parks, POIs, stations, districts and the plaza', () => {
    expect(world.parks).toHaveLength(2);
    expect(world.parks.find((p) => p.name === '서울숲')).toBeDefined();

    const cats = Object.fromEntries(world.pois.map((p) => [p.id, p.cat]));
    expect(cats).toEqual({
      n100: 'cafe',
      n101: 'store',
      n102: 'music',
      n103: 'music',
      n104: 'school',
      n105: 'book',
      n106: 'subway',
      n108: 'plaza',
      w21: 'park',
    });
    expect(byId(world.pois, 'n100').name).toBe('블루보틀 성수');

    expect(world.stations).toHaveLength(1);
    expect(world.stations[0]).toMatchObject({ id: 'n106', name: '성수' });
    expect(world.stations[0]!.x).toBeCloseTo(60 / 8, 1);

    expect(world.districts.find((d) => d.name === '성수동2가')).toMatchObject({ x: -5, z: -5 });
    expect(world.plaza?.x).toBeCloseTo(0.25, 1);
    // 3 m south of the origin: +z (north is -z).
    expect(world.plaza?.z).toBeCloseTo(0.375, 1);
  });

  it('honours unitMeters and origin options', () => {
    const w = buildWorld(raw, { name: 'Fixture', unitMeters: 4, origin: { lat: 37.544, lng: 127.055 } });
    expect(validateWorldData(w).ok).toBe(true);
    expect(byId(w.buildings, 'w1').height).toBeCloseTo(45 / 4);
    expect(w.bounds.maxX - w.bounds.minX).toBeCloseTo(50, 0);
    expect(w.bounds.minX).toBeGreaterThan(-12.5 * 2 + 5);
  });

  it('serializes one feature per line and round-trips', () => {
    const text = stringifyWorld(world);
    expect(JSON.parse(text)).toEqual(world);
    expect(text.split('\n').length).toBeGreaterThan(world.buildings.length + world.roads.length);
  });

  it('rejects bad input', () => {
    expect(() => buildWorld({} as OverpassResponse, { name: 'x' })).toThrow(TypeError);
    expect(() => buildWorld({ elements: [] }, { name: 'x' })).toThrow(/bbox/);
    expect(() =>
      buildWorld(raw, { name: 'x', bbox: { south: 1, west: 1, north: 0, east: 2 } }),
    ).toThrow(RangeError);
  });
});

describe('buildWorld with Korean building heights', () => {
  const { world, stats } = buildWorldWithStats(raw, { name: 'Fixture', krBuildings: kr });

  it('joins by >= 50% overlap', () => {
    const w1 = byId(world.buildings, 'w1');
    expect(w1).toMatchObject({ levels: 20, kind: 'glass' });
    expect(w1.height).toBeCloseTo(62.5 / 8, 2);
  });

  it('falls back to centroid-in-polygon when overlap is small', () => {
    expect(byId(world.buildings, 'w3')).toMatchObject({ height: 1.2, levels: 3, kind: 'office' });
  });

  it('does not join on a small overlap without the centroid', () => {
    expect(byId(world.buildings, 'w4')).toMatchObject({ height: 9 / 8 });
  });

  it('ignores features without height data, reports matches and adds attribution', () => {
    expect(byId(world.buildings, 'w2').height).toBe(75 / 8);
    expect(stats.krIndexed).toBe(3);
    expect(stats.krMatches).toEqual({ overlap: 1, centroid: 1 });
    expect(world.attribution).toEqual([OSM_ATTRIBUTION, KR_ATTRIBUTION]);
    expect(validateWorldData(world).ok).toBe(true);
  });
});

describe('checked-in Seongsu sample', () => {
  const path = new URL('../samples/seongsu.world.json', import.meta.url);
  it.skipIf(!existsSync(path))('is valid WorldData with CCW footprints and stays under 3 MB', () => {
    const text = readFileSync(path, 'utf8');
    expect(Buffer.byteLength(text)).toBeLessThan(3 * 1024 * 1024);
    const world = JSON.parse(text) as WorldData;
    expect(validateWorldData(world)).toEqual({ ok: true });
    expect(world.buildings.length).toBeGreaterThan(100);
    expect(world.roads.length).toBeGreaterThan(20);
    expect(world.attribution).toContain(OSM_ATTRIBUTION);
    for (const b of world.buildings) expect(signedArea(b.footprint)).toBeGreaterThan(0);
    expect(new Set(world.buildings.map((b) => b.id)).size).toBe(world.buildings.length);
    expect(new Set(world.roads.map((r) => r.id)).size).toBe(world.roads.length);
  });
});
