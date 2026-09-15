import { createProjection, type WorldData } from '@maprama/protocol';
import { describe, expect, it } from 'vitest';
import { loadWorldData, resolveWorldSource, WorldLoadError } from './data.js';
import { asRectangle, normalizeRing, offsetRing, signedArea } from './polygon.js';

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

  it('converts footprints (skipping degenerate ones) and adds the plaza landmark when free', () => {
    const ids = w.buildings.map((b) => b.id);
    expect(ids).toEqual(['b1', 'b2', 'b3', 'landmark']);
    const b1 = w.buildings[0]!;
    expect(b1.rect).not.toBeNull();
    expect(b1.rect!.w).toBeCloseTo(4);
    expect(b1).toMatchObject({ x: 5, z: 5, h: 4, levels: 10, kind: 'glass', name: 'Tower' });
    const b3 = w.buildings[2]!;
    expect(b3.rect).toBeNull();
    expect(b3.footprint).toHaveLength(6);
    for (const b of w.buildings) expect(signedArea(b.footprint)).toBeGreaterThan(0);
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
  it('builds procedural layouts', async () => {
    expect((await resolveWorldSource({ kind: 'procedural', layout: 'grid' })).kind).toBe('grid');
    expect((await resolveWorldSource({ kind: 'procedural', layout: 'town' })).kind).toBe('town');
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
