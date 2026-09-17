import { createProjection, type WorldData } from '@maprama/protocol';
import { describe, expect, it } from 'vitest';
import { loadWorldData, resolveWorldSource, WorldLoadError } from './data.js';
import { asRectangle, normalizeRing, offsetRing, signedArea } from './polygon.js';
import { buildGridWorld } from './grid.js';
import { buildTownWorld } from './town.js';

function sampleWorld(): WorldData {
  return {
    version: 1,
    name: 'Test Town',
    origin: { lng: 126.978, lat: 37.5665 },
    unitMeters: 8,
    bounds: { minX: -50, minZ: -50, maxX: 50, maxZ: 50 },
    roads: [
      { id: 'r1', name: 'Main St', cls: 'arterial', pts: [[-50, 0], [50, 0]] },
      { id: 'r2', cls: 'alley', bridge: true, pts: [[0, -50], [0, 50]] },
      { id: 'r3', cls: 'local', pts: [[20, -50], [20, 50]] },
    ],
    buildings: [
      { id: 'b1', footprint: [[3, 3], [7, 3], [7, 7], [3, 7]], height: 4, levels: 10, kind: 'glass', name: 'Tower' },
      { id: 'b2', footprint: [[-5, -5], [-3, -1], [-1, -5]], height: 1.5 },
      { id: 'b3', footprint: [[-20, 10], [-10, 10], [-10, 14], [-14, 14], [-14, 20], [-20, 20]], height: 3, kind: 'office' },
      { id: 'degenerate', footprint: [[0, 0], [1, 0], [2, 0]], height: 1 },
    ],
    water: [[[10, 10], [20, 10], [20, 20]]],
    parks: [{ name: 'Green', poly: [[-20, -20], [-10, -20], [-10, -10]] }],
    pois: [{ id: 'p1', name: 'Cafe', cat: 'cafe', x: 3, z: -4 }],
    stations: [{ id: 's1', name: 'City Hall', x: -8, z: 8 }],
    districts: [{ name: 'Jung-gu', x: 0, z: 0 }],
    plaza: { x: -35, z: -35 },
    attribution: ['© OpenStreetMap contributors'],
  };
}

describe('loadWorldData', () => {
  const src = sampleWorld();
  const w = loadWorldData(src);

  it('keeps projection parameters consistent with the protocol projection', () => {
    expect(w.origin).toEqual(src.origin);
    expect(w.unitMeters).toBe(8);
    const proj = createProjection({ origin: w.origin, unitMeters: w.unitMeters });
    const ll = proj.toLngLat({ x: 12.5, z: -7 });
    const back = proj.toWorld(ll);
    expect(back.x).toBeCloseTo(12.5, 9);
    expect(back.z).toBeCloseTo(-7, 9);
    // +z is south
    expect(proj.toLngLat({ x: 0, z: 10 }).lat).toBeLessThan(src.origin.lat);
  });

  it('converts footprints (skipping degenerate ones) and invents no extra building', () => {
    const ids = w.buildings.map((b) => b.id);
    expect(ids).toEqual(['b1', 'b2', 'b3']);
    const b1 = w.buildings[0]!;
    expect(b1.rect).not.toBeNull();
    expect(b1.rect!.w).toBeCloseTo(4);
    expect(b1).toMatchObject({ x: 5, z: 5, h: 4, levels: 10, kind: 'glass', name: 'Tower' });
    const b3 = w.buildings[2]!;
    expect(b3.rect).toBeNull();
    expect(b3.footprint).toHaveLength(6);
    for (const b of w.buildings) expect(signedArea(b.footprint)).toBeGreaterThan(0);
  });

  it('never synthesises a building at the plaza, wherever the plaza sits', () => {
    // real footprints, minus the degenerate one that is dropped on purpose
    const real = src.buildings.length - 1;

    // (a) open plaza, far from every footprint (the old behaviour added a tower here)
    const open = loadWorldData(src);
    expect(open.buildings).toHaveLength(real);
    expect(open.buildings.some((b) => b.landmark)).toBe(false);
    expect(open.buildings.some((b) => b.id === 'landmark')).toBe(false);
    expect(open.plaza).toEqual({ x: -35, z: -35, radius: 6.4 });
    expect(open.start).toEqual({ x: -35, z: -35 });

    // (b) plaza inside a real footprint (b1 spans 3..7 on both axes)
    const covered = loadWorldData({ ...src, plaza: { x: 5, z: 5 } });
    expect(covered.buildings).toHaveLength(real);
    expect(covered.buildings.some((b) => b.landmark)).toBe(false);
    expect(covered.plaza).toEqual({ x: 5, z: 5, radius: 6.4 });

    // (c) no plaza at all: the world is framed on the centre of its bounds
    const none = loadWorldData({ ...src, plaza: undefined });
    expect(none.buildings).toHaveLength(real);
    expect(none.plaza).toBeNull();
    expect(none.start).toEqual({ x: 0, z: 0 });
  });

  it('builds the road graph with classes and bridges', () => {
    const classes = new Set(w.graph.edges.map((e) => e.cls));
    expect(classes).toEqual(new Set(['arterial', 'alley', 'local']));
    expect(w.graph.edges.some((e) => e.bridge && e.roadId === 'r2')).toBe(true);
    // r1 is split by r2 and r3
    expect(w.graph.edges.filter((e) => e.roadId === 'r1')).toHaveLength(3);
  });

  it('keeps water, parks, POIs, stations, districts and attribution', () => {
    expect(w.water).toHaveLength(1);
    expect(w.parks[0]!.name).toBe('Green');
    expect(w.pois).toHaveLength(1);
    expect(w.stations).toHaveLength(1);
    expect(w.districts).toHaveLength(1);
    expect(w.attribution).toEqual(['© OpenStreetMap contributors']);
    expect(w.kind).toBe('data');
  });
});

describe('resolveWorldSource', () => {
  it('fetches and validates url worlds', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => sampleWorld() });
    const w = await resolveWorldSource({ kind: 'url', url: 'https://example.test/w.json' }, fetchImpl);
    expect(w.name).toBe('Test Town');
  });
  it('rejects invalid documents and HTTP errors with WorldLoadError', async () => {
    await expect(resolveWorldSource({ kind: 'url', url: 'x' }, async () => ({ ok: true, status: 200, json: async () => ({ version: 2 }) }))).rejects.toBeInstanceOf(WorldLoadError);
    await expect(resolveWorldSource({ kind: 'url', url: 'x' }, async () => ({ ok: false, status: 404, json: async () => null }))).rejects.toThrow(/404/);
  });
  it('builds procedural layouts, which keep their own landmark', async () => {
    const grid = await resolveWorldSource({ kind: 'procedural', layout: 'grid' });
    const town = await resolveWorldSource({ kind: 'procedural', layout: 'town' });
    expect(grid.kind).toBe('grid');
    expect(town.kind).toBe('town');
    // the landmark is part of the generated (clearly fictional) worlds, not of real data
    expect(grid.buildings.filter((b) => b.landmark)).toHaveLength(1);
    expect(town.buildings.filter((b) => b.landmark)).toHaveLength(1);
    const data = await resolveWorldSource({ kind: 'data', world: sampleWorld() });
    expect(data.buildings.some((b) => b.landmark)).toBe(false);
  });
});

describe('polygon helpers', () => {
  it('normalizes winding and offsets outward', () => {
    const cw = normalizeRing([[0, 0], [0, 2], [2, 2], [2, 0]]);
    expect(signedArea(cw)).toBeCloseTo(4);
    const out = offsetRing(cw, 0.5);
    expect(signedArea(out)).toBeCloseTo(9);
  });
  it('detects rotated rectangles', () => {
    const a = 0.5, c = Math.cos(a), s = Math.sin(a);
    const pts = [[-2, -1], [2, -1], [2, 1], [-2, 1]].map(([u, v]) => [10 + u! * c + v! * s, 5 - u! * s + v! * c] as [number, number]);
    const r = asRectangle(normalizeRing(pts))!;
    expect(r.x).toBeCloseTo(10);
    expect(r.z).toBeCloseTo(5);
    expect(Math.max(r.w, r.d)).toBeCloseTo(4);
    expect(Math.min(r.w, r.d)).toBeCloseTo(2);
    expect(asRectangle(normalizeRing([[0, 0], [4, 0], [5, 3], [0, 3]]))).toBeNull();
  });
});

describe('non-tile worlds are untouched by tile support', () => {
  it('leaves every world source that existed before tiles without water rims', () => {
    // A `null` here is what makes the static renderer take exactly the code
    // path it took before tile worlds existed (one closed ring per water
    // polygon, interleaved with the water fill in the same order). Only a tile
    // world supplies its own rims, because only a tile world has cut edges that
    // are not banks.
    expect(loadWorldData(sampleWorld()).waterRims).toBeNull();
    expect(buildTownWorld(0).waterRims).toBeNull();
    expect(buildGridWorld(0).waterRims).toBeNull();
  });

  it('still numbers a data world\u2019s buildings by their position in the document', () => {
    // Tile worlds seed a building's look from its id (their array order depends
    // on which tiles are loaded). A `data` world must keep the old behaviour, or
    // every existing world would change appearance.
    const world = loadWorldData(sampleWorld());
    expect(world.buildings.map((b) => b.idx)).toEqual(world.buildings.map((_, i) => i));
    expect(world.kind).toBe('data');
  });
});
