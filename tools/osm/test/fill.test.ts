import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateWorldData, type BuildingFootprint, type WorldData } from '@maprama/protocol';
import { KR_ATTRIBUTION, KR_ID_PREFIX, OSM_ATTRIBUTION, buildWorld, buildWorldWithStats } from '../src/build.js';
import { signedArea } from '../src/geometry.js';
import { OsmFootprintIndex, krFeatureKey } from '../src/kr.js';
import type { OverpassResponse } from '../src/types.js';
import type { Vec2 } from '@maprama/protocol';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;

/** One OSM building; the national dataset has three polygons in the same bbox. */
const raw = fixture('fill-gaps.overpass.json') as OverpassResponse;
const kr = fixture('fill-gaps.kr.geojson');
const base = { name: 'Fill', krBuildings: kr } as const;

const byId = (world: WorldData, id: string): BuildingFootprint => {
  const found = world.buildings.find((b) => b.id === id);
  if (!found) throw new Error(`missing ${id} in ${world.buildings.map((b) => b.id).join(',')}`);
  return found;
};
const filledOf = (world: WorldData): BuildingFootprint[] =>
  world.buildings.filter((b) => b.id.startsWith(KR_ID_PREFIX));

describe('krFillMissing is off by default', () => {
  it('keeps the OSM-only result when only --kr-buildings is given', () => {
    const { world, stats } = buildWorldWithStats(raw, base);
    expect(world.buildings.map((b) => b.id)).toEqual(['w1']);
    expect(stats).toMatchObject({ buildings: 1, buildingsFromOsm: 1, buildingsFilled: 0, krFillSkipped: 0 });
    // The three dataset polygons are still indexed and still supply the height.
    expect(stats.krIndexed).toBe(3);
    expect(stats.krMatches).toEqual({ overlap: 1, centroid: 0 });
    expect(byId(world, 'w1').height).toBeCloseTo(21 / 8, 6);
  });

  it('is a no-op without a dataset, even when asked for', () => {
    const { world, stats } = buildWorldWithStats(raw, { name: 'Fill', krFillMissing: true });
    expect(world.buildings.map((b) => b.id)).toEqual(['w1']);
    expect(stats.buildingsFilled).toBe(0);
    expect(world.attribution).toEqual([OSM_ATTRIBUTION]);
  });
});

describe('krFillMissing fills the buildings OSM is missing', () => {
  const { world, stats } = buildWorldWithStats(raw, { ...base, krFillMissing: true });
  const filled = filledOf(world);

  it('keeps the OSM building and does not duplicate it from the dataset', () => {
    expect(byId(world, 'w1')).toMatchObject({ name: '성수테스트빌딩', levels: 6 });
    expect(byId(world, 'w1').height).toBeCloseTo(21 / 8, 6);
    // The record overlapping w1 (21 m / 6 floors) is skipped, not emitted again.
    expect(filled.some((b) => Math.abs(b.height - 21 / 8) < 1e-9)).toBe(false);
    expect(stats.krFillSkipped).toBe(1);
  });

  it('emits the two missing records with their own heights and floors', () => {
    expect(filled).toHaveLength(2);
    const tall = filled.find((b) => b.levels === 20);
    const low = filled.find((b) => b.levels === 5);
    expect(tall?.height).toBeCloseTo(72 / 8, 6); // HEIGHT = 72 m
    expect(tall?.kind).toBe('glass'); // >= 60 m
    expect(low?.height).toBeCloseTo((5 * 3.2) / 8, 6); // HEIGHT = 0 -> GRND_FLR x 3.2 m
    expect(low?.kind).toBe('brick'); // 16 m, no OSM tags
    expect(low?.name).toBeUndefined(); // the parsed shape carries no name attribute
  });

  it('reports OSM, filled and skipped counts', () => {
    expect(stats).toMatchObject({
      buildings: 3,
      buildingsFromOsm: 1,
      buildingsFilled: 2,
      krFillSkipped: 1,
      krIndexed: 3,
    });
    expect(stats.buildings).toBe(world.buildings.length);
    expect(stats.heightSources).toMatchObject({ 'kr-height': 2, 'kr-levels': 1, heuristic: 0 });
  });

  it('gives generated buildings ids that cannot collide with OSM ids', () => {
    for (const b of filled) {
      expect(b.id).toMatch(/^k[0-9a-f]{16}$/);
      expect(/^[nwr]\d/.test(b.id)).toBe(false);
    }
    const ids = world.buildings.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps those ids stable across runs and across build options', () => {
    const again = buildWorld(raw, { ...base, krFillMissing: true });
    expect(again.buildings.map((b) => b.id)).toEqual(world.buildings.map((b) => b.id));
    // Ids come from the source lng/lat ring, so projection and output settings
    // must not change them.
    const other = buildWorld(raw, {
      ...base,
      krFillMissing: true,
      unitMeters: 4,
      precision: 4,
      simplifyMeters: 0,
      origin: { lat: 37.5445, lng: 127.056 },
    });
    expect(filledOf(other).map((b) => b.id).sort()).toEqual(filled.map((b) => b.id).sort());
  });

  it('runs generated footprints through the normal geometry pipeline', () => {
    expect(validateWorldData(world)).toEqual({ ok: true });
    for (const b of filled) {
      expect(signedArea(b.footprint)).toBeGreaterThan(0); // counter-clockwise
      expect(b.footprint[0]).not.toEqual(b.footprint[b.footprint.length - 1]); // open ring
      for (const [x, z] of b.footprint) {
        expect(x).toBeGreaterThanOrEqual(world.bounds.minX - 1e-6);
        expect(x).toBeLessThanOrEqual(world.bounds.maxX + 1e-6);
        expect(z).toBeGreaterThanOrEqual(world.bounds.minZ - 1e-6);
        expect(z).toBeLessThanOrEqual(world.bounds.maxZ + 1e-6);
      }
    }
  });

  it('honours --precision and the minimum-area filter', () => {
    const rounded = buildWorld(raw, { ...base, krFillMissing: true, precision: 0 });
    expect(filledOf(rounded)).toHaveLength(2);
    for (const b of filledOf(rounded)) {
      for (const [x, z] of b.footprint) {
        expect(Number.isInteger(x)).toBe(true);
        expect(Number.isInteger(z)).toBe(true);
      }
    }

    const strict = buildWorldWithStats(raw, { ...base, krFillMissing: true, minBuildingAreaM2: 100000 });
    expect(strict.world.buildings).toHaveLength(0);
    expect(strict.stats.buildingsFilled).toBe(0);
  });

  it('keeps the national dataset attribution', () => {
    expect(world.attribution).toEqual([OSM_ATTRIBUTION, KR_ATTRIBUTION]);
  });
});

describe('OsmFootprintIndex (the "already represented by OSM" test)', () => {
  const rect = (x0: number, z0: number, x1: number, z1: number): Vec2[] => [
    [x0, z0],
    [x1, z0],
    [x1, z1],
    [x0, z1],
  ];
  /** One OSM building: the square (0, 0)–(10, 10). */
  const indexed = (): OsmFootprintIndex => {
    const index = new OsmFootprintIndex();
    index.add(rect(0, 0, 10, 10));
    return index;
  };

  it('reports a record covered by an OSM footprint', () => {
    expect(indexed().covers(rect(1, 1, 10, 10))).toBe(true); // >= 50% of the record's area
    expect(indexed().covers(rect(4, 4, 5, 5))).toBe(true); // wholly inside a much larger OSM building
    expect(indexed().covers(rect(-10, 4, 14, 8))).toBe(true); // only 42% overlap, but its centroid is inside
  });

  it('reports a record OSM does not have', () => {
    expect(indexed().covers(rect(40, 40, 45, 45))).toBe(false); // far away
    expect(indexed().covers(rect(9, -4, 17, 4))).toBe(false); // clips a corner only
    expect(new OsmFootprintIndex().covers(rect(0, 0, 5, 5))).toBe(false); // no OSM buildings at all
  });
});

describe('krFeatureKey', () => {
  const ring: [number, number][] = [
    [127.0562, 37.5443],
    [127.0565, 37.5443],
    [127.0565, 37.5445],
    [127.0562, 37.5445],
    [127.0562, 37.5443],
  ];

  it('is deterministic, 16 hex characters, and sensitive to the geometry', () => {
    expect(krFeatureKey(ring)).toMatch(/^[0-9a-f]{16}$/);
    expect(krFeatureKey(ring)).toBe(krFeatureKey(ring.map(([lng, lat]) => [lng, lat])));
    expect(krFeatureKey(ring)).not.toBe(krFeatureKey(ring.map(([lng, lat]) => [lng + 0.0001, lat])));
  });
});
