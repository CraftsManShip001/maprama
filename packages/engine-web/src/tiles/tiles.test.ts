import { decodeTile, type MtilTile } from '@maprama/protocol';
import { describe, expect, it, vi } from 'vitest';
import { encodeTile } from '../../../protocol/src/__fixtures__/tile.js';
import { assembleTileWorld } from './assemble.js';
import { openArchive, TileArchiveError, type PMTilesLike, type TileArchive } from './archive.js';
import { EARTH_CIRCUMFERENCE, TileFrame, lngLatToMercator, mercatorToLngLat, metresPerUnitAt, tileOf } from './mercator.js';
import { EDGE_HALO_METERS, TileStreamer, tileRange, tilesNeeded } from './streamer.js';
import { REBASE_METERS, TileWorld } from './world.js';

const SEOUL = { lng: 127.056, lat: 37.5445 };
const BUSAN = { lng: 129.056, lat: 35.1575 };
const EXTENT = 8192;
const BUFFER = 256;

const seoulTile = tileOf(SEOUL.lng, SEOUL.lat, 15);

/** A tile with a river band clipped at the east and west clip edges. */
const riverTile = (): MtilTile =>
  decodeTile(
    encodeTile({
      extent: EXTENT,
      buffer: BUFFER,
      attribution: [0, 1],
      layers: {
        water: [{ poly: [[-BUFFER, 3000], [EXTENT + BUFFER, 3000], [EXTENT + BUFFER, 4000], [-BUFFER, 4000]] }],
        roads: [{ id: 'r#0', cls: 'arterial', pts: [[-BUFFER, 1000], [EXTENT + BUFFER, 1000]] }],
        buildings: [{ id: 'edge', heightDm: 300, footprint: [[EXTENT - 200, 6000], [EXTENT + 380, 6000], [EXTENT + 380, 6400], [EXTENT - 200, 6400]] }],
        pois: [{ id: 'p', name: 'Cafe', cat: 'cafe', u: 100, v: 100, buildingId: 'somewhere-else' }],
      },
    }),
  );

/** A tile with one closed pond that touches no boundary. */
const pondTile = (): MtilTile =>
  decodeTile(encodeTile({ extent: EXTENT, buffer: BUFFER, layers: { water: [{ poly: [[1000, 1000], [2000, 1000], [2000, 2000], [1000, 2000]] }] } }));

describe('TileFrame', () => {
  it('is exact in both directions', () => {
    const frame = new TileFrame(SEOUL, SEOUL.lat, 8);
    for (const p of [SEOUL, BUSAN, { lng: 126.5, lat: 33.4 }, { lng: 129.5, lat: 38.5 }]) {
      const back = frame.toLngLat(frame.toWorld(p));
      expect(back.lng).toBeCloseTo(p.lng, 9);
      expect(back.lat).toBeCloseTo(p.lat, 9);
    }
  });

  it('places the anchor at the origin and is true to scale there', () => {
    const frame = new TileFrame(SEOUL, SEOUL.lat, 8);
    expect(frame.toWorld(SEOUL)).toEqual({ x: 0, z: 0 });
    // 800 m of ground east of the anchor must be exactly 100 world units.
    const metresPerDegree = (EARTH_CIRCUMFERENCE * Math.cos((SEOUL.lat * Math.PI) / 180)) / 360;
    expect(frame.toWorld({ lng: SEOUL.lng + 800 / metresPerDegree, lat: SEOUL.lat }).x).toBeCloseTo(100, 6);
    expect(frame.anchorUnitMeters).toBeCloseTo(8, 9);
  });

  it('places neighbouring tiles edge to edge, below what a vertex buffer can resolve', () => {
    const frame = new TileFrame(SEOUL, SEOUL.lat, 8);
    const a = frame.tilePlacement(15, seoulTile.x, seoulTile.y, EXTENT);
    const b = frame.tilePlacement(15, seoulTile.x + 1, seoulTile.y, EXTENT);
    expect(a.scale).toBe(b.scale);
    // The east edge of `a` and the west edge of `b` differ only by float64
    // rounding — and once the vertices are written into the renderer's
    // `Float32Array` the two are the *same* number, so a seam cannot exist.
    const gap = Math.abs(a.originX + EXTENT * a.scale - b.originX);
    expect(gap).toBeLessThan(1e-9);
    expect(Math.fround(a.originX + EXTENT * a.scale)).toBe(Math.fround(b.originX));
  });

  it('re-bases by a pure translation', () => {
    const frame = new TileFrame(SEOUL, SEOUL.lat, 8);
    const before = [SEOUL, BUSAN, { lng: 128, lat: 36 }].map((p) => frame.toWorld(p));
    const scaleBefore = frame.unitsPerMercator;
    const d = frame.rebase(BUSAN);
    const after = [SEOUL, BUSAN, { lng: 128, lat: 36 }].map((p) => frame.toWorld(p));
    expect(frame.unitsPerMercator).toBe(scaleBefore);
    for (let i = 0; i < before.length; i++) {
      // Every point moved by exactly the same delta — that is what makes the
      // re-base invisible once the camera takes the same delta.
      expect(after[i]!.x).toBeCloseTo(before[i]!.x + d.dx, 6);
      expect(after[i]!.z).toBeCloseTo(before[i]!.z + d.dz, 6);
    }
    expect(frame.toWorld(BUSAN).x).toBeCloseTo(0, 9);
  });

  it('reports the ground metres per unit at the anchor, which drifts like Mercator', () => {
    const frame = new TileFrame(SEOUL, SEOUL.lat, 8);
    expect(frame.anchorUnitMeters).toBeCloseTo(8, 9);
    frame.rebase(BUSAN);
    // Busan is 2.4° further south, so a Mercator unit covers 3.1 % more ground.
    expect(frame.anchorUnitMeters).toBeCloseTo(8 * (Math.cos((35.1575 * Math.PI) / 180) / Math.cos((37.5445 * Math.PI) / 180)), 6);
    expect(metresPerUnitAt(8, 37.5445, 37.5445)).toBeCloseTo(8, 9);
  });

  it('agrees with the slippy-tile rule', () => {
    const m = lngLatToMercator(SEOUL.lng, SEOUL.lat);
    expect(tileOf(SEOUL.lng, SEOUL.lat, 15)).toEqual({ z: 15, x: Math.floor(m.mx * 32768), y: Math.floor(m.my * 32768) });
    const back = mercatorToLngLat(m.mx, m.my);
    expect(back.lat).toBeCloseTo(SEOUL.lat, 9);
  });
});

describe('assembleTileWorld', () => {
  const frame = (): TileFrame => new TileFrame(SEOUL, SEOUL.lat, 8);

  it('keeps a clipped river free of banks along the cut', () => {
    const w = assembleTileWorld([{ z: 15, x: seoulTile.x, y: seoulTile.y, tile: riverTile() }], { frame: frame(), attribution: [], name: 'x' });
    expect(w.water).toHaveLength(1);
    // Two open rims (the real north and south banks), not one closed ring: a
    // rim on the cut would be a wall across the middle of the river.
    expect(w.waterRims).toHaveLength(2);
    for (const rim of w.waterRims!) expect(rim).toHaveLength(2);
  });

  it('keeps the closed ring of a polygon that was never cut', () => {
    const w = assembleTileWorld([{ z: 15, x: seoulTile.x, y: seoulTile.y, tile: pondTile() }], { frame: frame(), attribution: [], name: 'x' });
    expect(w.waterRims).toHaveLength(1);
    expect(w.waterRims![0]).toHaveLength(5);
  });

  it('keeps an anchor-owned building whole, past the tile edge', () => {
    const w = assembleTileWorld([{ z: 15, x: seoulTile.x, y: seoulTile.y, tile: riverTile() }], { frame: frame(), attribution: [], name: 'x' });
    const b = w.buildings.find((x) => x.id === 'edge')!;
    const f = frame();
    const place = f.tilePlacement(15, seoulTile.x, seoulTile.y, EXTENT);
    const east = Math.max(...b.footprint.map((p) => p[0]));
    expect(east).toBeGreaterThan(place.originX + EXTENT * place.scale);
  });

  it('converts decimetre heights to world units with the tile latitude', () => {
    const w = assembleTileWorld([{ z: 15, x: seoulTile.x, y: seoulTile.y, tile: riverTile() }], { frame: frame(), attribution: [], name: 'x' });
    // 300 dm = 30 m; one world unit is 8 m at the reference latitude, and the
    // tile sits essentially at it.
    expect(w.buildings.find((x) => x.id === 'edge')!.h).toBeCloseTo(30 / 8, 2);
  });

  it('keeps a POI whose building lives in a tile that is not loaded', () => {
    const w = assembleTileWorld([{ z: 15, x: seoulTile.x, y: seoulTile.y, tile: riverTile() }], { frame: frame(), attribution: [], name: 'x' });
    expect(w.pois[0]!.buildingId).toBe('somewhere-else');
    expect(w.buildings.some((b) => b.id === 'somewhere-else')).toBe(false);
  });

  it('treats a tile the archive does not have as ground, not as a failure', () => {
    const w = assembleTileWorld([{ z: 15, x: seoulTile.x, y: seoulTile.y, tile: null }], { frame: frame(), attribution: ['©'], name: 'x' });
    expect(w.buildings).toHaveLength(0);
    // No paving where there is no data, but the ground still reaches the tile.
    expect(w.pads).toHaveLength(0);
    expect(w.bounds.maxX).toBeGreaterThan(w.bounds.minX);
    expect(w.attribution).toEqual(['©']);
  });

  it('assembles nothing at all without throwing', () => {
    const w = assembleTileWorld([], { frame: frame(), attribution: [], name: 'x' });
    expect(w.kind).toBe('tiles');
    expect(w.buildings).toHaveLength(0);
    expect(w.bounds).toEqual({ minX: -1, minZ: -1, maxX: 1, maxZ: 1 });
  });

  it('overlaps clipped road pieces across the shared edge, so the road never thins out', () => {
    const f = frame();
    const place = f.tilePlacement(15, seoulTile.x, seoulTile.y, EXTENT);
    const edge = place.originX + EXTENT * place.scale;
    const w = assembleTileWorld([{ z: 15, x: seoulTile.x, y: seoulTile.y, tile: riverTile() }], { frame: f, attribution: [], name: 'x' });
    const xs = w.graph.nodes.map((n) => n.x);
    // Roads are clipped to the tile *plus* the 256-unit buffer, so this tile's
    // road reaches 30 m past the shared boundary and the neighbour's reaches
    // 30 m back the other way. The overlap is what stops a road from getting
    // thinner (and its end cap from showing) at every tile edge.
    const overshootMeters = (Math.max(...xs) - edge) * 8;
    expect(overshootMeters).toBeGreaterThan(25);
    expect(overshootMeters).toBeLessThan(35);
  });

  it('carries a projection whose origin is the anchor', () => {
    const f = frame();
    const w = assembleTileWorld([], { frame: f, attribution: [], name: 'x' });
    expect(w.projection!.origin.lng).toBeCloseTo(SEOUL.lng, 9);
    expect(w.projection!.toWorld(SEOUL).x).toBeCloseTo(0, 9);
    expect(w.projection!.toLngLat({ x: 0, z: 0 }).lat).toBeCloseTo(SEOUL.lat, 9);
  });
});

/* ------------------------------------------------------------- fake archive */

interface FakeOptions {
  have?: (z: number, x: number, y: number) => boolean;
  fail?: (z: number, x: number, y: number) => boolean;
}

function fakeArchive(opts: FakeOptions = {}): TileArchive & { calls: string[] } {
  const calls: string[] = [];
  return {
    url: 'memory://a.pmtiles',
    minZoom: 13,
    maxZoom: 15,
    metadata: { format: 'maprama-mtil-1', name: 'Fake' },
    attribution: ['© OpenStreetMap contributors', 'Heights: NSDI'],
    extent: EXTENT,
    buffer: BUFFER,
    calls,
    async getTile(z, x, y) {
      calls.push(`${z}/${x}/${y}`);
      if (opts.fail?.(z, x, y)) throw new Error('boom');
      if (opts.have && !opts.have(z, x, y)) return null;
      return encodeTile({ extent: EXTENT, buffer: BUFFER, attribution: [0], layers: { stations: [{ id: `s-${x}-${y}`, name: 's', u: 10, v: 10 }] } });
    },
  };
}

const boxAround = (lng: number, lat: number, d: number): { west: number; south: number; east: number; north: number } => ({
  west: lng - d,
  east: lng + d,
  south: lat - d,
  north: lat + d,
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe('TileStreamer', () => {
  it('loads the tiles covering the box and reports the change once they arrive', async () => {
    const archive = fakeArchive();
    const s = new TileStreamer(archive, { detailZoom: 15, overviewZoom: 13, budget: 96, onChange: () => {} });
    const box = boxAround(SEOUL.lng, SEOUL.lat, 0.002);
    expect(s.step(box).changed).toBe(false);
    expect(s.loading).toBe(true);
    await flush();
    const after = s.step(box);
    expect(after.changed).toBe(true);
    expect(s.entries().length).toBe(tilesNeeded(box, 15));
    expect(s.stats().inflight).toBe(0);
  });

  it('drops to the overview level when the detail level would not fit the budget', () => {
    const s = new TileStreamer(fakeArchive(), { detailZoom: 15, overviewZoom: 13, budget: 16, onChange: () => {} });
    expect(s.step(boxAround(SEOUL.lng, SEOUL.lat, 0.002)).zoom).toBe(15);
    expect(s.step(boxAround(SEOUL.lng, SEOUL.lat, 0.2)).zoom).toBe(13);
  });

  it('throws away tiles the camera left behind, budget or no budget', async () => {
    const archive = fakeArchive();
    const s = new TileStreamer(archive, { detailZoom: 15, overviewZoom: 13, budget: 1000, onChange: () => {} });
    s.step(boxAround(SEOUL.lng, SEOUL.lat, 0.002));
    await flush();
    s.step(boxAround(SEOUL.lng, SEOUL.lat, 0.002));
    const near = s.entries().length;
    expect(near).toBeGreaterThan(0);
    s.step(boxAround(BUSAN.lng, BUSAN.lat, 0.002));
    await flush();
    s.step(boxAround(BUSAN.lng, BUSAN.lat, 0.002));
    // Nothing from Seoul survives: one world, one coordinate frame.
    for (const e of s.entries()) expect(Math.abs(e.x - tileOf(BUSAN.lng, BUSAN.lat, 15).x)).toBeLessThan(8);
  });

  it('asks for an empty tile once and remembers that it is empty', async () => {
    const archive = fakeArchive({ have: () => false });
    const s = new TileStreamer(archive, { detailZoom: 15, overviewZoom: 13, budget: 96, onChange: () => {} });
    const box = boxAround(SEOUL.lng, SEOUL.lat, 0.002);
    s.step(box);
    await flush();
    const first = archive.calls.length;
    s.step(box);
    s.step(box);
    await flush();
    expect(archive.calls.length).toBe(first);
    expect(s.stats().empty).toBe(first);
  });

  it('survives a tile that will not load, and reports it once', async () => {
    const onError = vi.fn();
    const archive = fakeArchive({ fail: () => true });
    const s = new TileStreamer(archive, { detailZoom: 15, overviewZoom: 13, budget: 96, onChange: () => {}, onError });
    const box = boxAround(SEOUL.lng, SEOUL.lat, 0.002);
    s.step(box);
    await flush();
    expect(onError).toHaveBeenCalled();
    const calls = archive.calls.length;
    s.step(box);
    await flush();
    expect(archive.calls.length).toBe(calls);
    expect(s.stats().failed).toBeGreaterThan(0);
  });

  it('credits the whole attribution table when the tiles carry no indices', async () => {
    const archive = fakeArchive();
    const s = new TileStreamer(archive, { detailZoom: 15, overviewZoom: 13, budget: 96, onChange: () => {} });
    expect(s.attribution()).toEqual(['© OpenStreetMap contributors', 'Heights: NSDI']);
    s.step(boxAround(SEOUL.lng, SEOUL.lat, 0.002));
    await flush();
    // The fake's tiles index only entry 0.
    expect(s.attribution()).toEqual(['© OpenStreetMap contributors']);
  });

  it('covers at least the visible box', () => {
    const box = boxAround(SEOUL.lng, SEOUL.lat, 0.01);
    const r = tileRange(box, 15);
    expect(tileOf(box.west, box.north, 15).x).toBe(r.x0);
    expect(tileOf(box.east, box.south, 15).x).toBe(r.x1);
  });
});

describe('openArchive', () => {
  const header = { minZoom: 13, maxZoom: 15, tileType: 0, tileCompression: 2 };
  const reader = (metadata: unknown): PMTilesLike => ({
    getHeader: async () => header,
    getMetadata: async () => metadata,
    getZxy: async () => undefined,
  });

  it('accepts a Maprama archive and reads its contract', async () => {
    const a = await openArchive('u', () => reader({ format: 'maprama-mtil-1', name: 'KR', extent: 8192, buffer: 256, attribution: ['©'] }));
    expect(a.extent).toBe(8192);
    expect(a.attribution).toEqual(['©']);
    expect(await a.getTile(15, 1, 1)).toBeNull();
  });

  it('refuses an archive that is not ours instead of decoding nonsense', async () => {
    await expect(openArchive('u', () => reader({ format: 'mvt' }))).rejects.toThrow(/expected "maprama-mtil-1"/);
    await expect(openArchive('u', () => reader({}))).rejects.toThrow(/invalid metadata/);
  });

  it('says what a host has to send when the first request fails', async () => {
    await expect(
      openArchive('https://cdn/x.pmtiles', () => {
        throw new Error('network');
      }),
    ).rejects.toThrow(/Access-Control-Expose-Headers/);
    await expect(openArchive('u', () => reader({ format: 'mvt' }))).rejects.toBeInstanceOf(TileArchiveError);
  });
});

describe('TileWorld', () => {
  const open = async (): Promise<TileWorld> => {
    const archive = fakeArchive();
    const w = await TileWorld.open(
      { kind: 'tiles', url: 'memory://a.pmtiles', center: SEOUL },
      {
        onChange: () => {},
        pmtiles: () => ({
          getHeader: async () => ({ minZoom: 13, maxZoom: 15, tileType: 0, tileCompression: 2 }),
          getMetadata: async () => ({ format: 'maprama-mtil-1', name: 'Fake', extent: EXTENT, buffer: BUFFER, attribution: ['©'] }),
          getZxy: async (z, x, y) => {
            const bytes = await archive.getTile(z, x, y);
            return bytes ? { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer } : undefined;
          },
        }),
      },
    );
    return w;
  };

  const corners = (cx: number, cz: number, r: number): { x: number; z: number }[] => [
    { x: cx - r, z: cz - r },
    { x: cx + r, z: cz - r },
    { x: cx + r, z: cz + r },
    { x: cx - r, z: cz + r },
  ];

  it('starts empty and fills in', async () => {
    const w = await open();
    expect(w.world.kind).toBe('tiles');
    expect(w.world.buildings).toHaveLength(0);
    const first = w.step({ x: 0, z: 0 }, corners(0, 0, 40));
    expect(first.loading).toBe(true);
    expect(first.rebase).toBeNull();
    await flush();
    expect(w.step({ x: 0, z: 0 }, corners(0, 0, 40)).changed).toBe(true);
    expect(w.world.stations.length).toBeGreaterThan(0);
    w.dispose();
  });

  it('does not re-base while the camera stays near the anchor', async () => {
    const w = await open();
    const nearUnits = (REBASE_METERS / 8) * 0.9;
    expect(w.step({ x: nearUnits, z: 0 }, corners(nearUnits, 0, 40)).rebase).toBeNull();
    w.dispose();
  });

  it('re-bases onto the camera once it drifts far enough that it cannot wait', async () => {
    const w = await open();
    // Beyond twice the threshold the re-base stops waiting for a tile change.
    const farUnits = (REBASE_METERS / 8) * 2.5;
    const before = w.frame.toLngLat({ x: farUnits, z: 0 });
    const step = w.step({ x: farUnits, z: 0 }, corners(farUnits, 0, 40));
    expect(step.rebase).not.toBeNull();
    // The camera, shifted by the delta, is exactly at the new origin.
    expect(farUnits + step.rebase!.dx).toBeCloseTo(0, 6);
    expect(w.frame.anchor.lng).toBeCloseTo(before.lng, 9);
    expect(w.frame.anchor.lat).toBeCloseTo(before.lat, 9);
    w.dispose();
  });

  it('waits for a tile change before re-basing, so the two share one rebuild', async () => {
    const w = await open();
    const farUnits = (REBASE_METERS / 8) * 1.5;
    const c = corners(farUnits, 0, 40);
    // Past the threshold, but the streamer has nothing new yet: no re-base, and
    // therefore no second rebuild of the world in the same second.
    expect(w.step({ x: farUnits, z: 0 }, c).rebase).toBeNull();
    await flush();
    // The tiles arrived, so this step rebuilds anyway — and takes the re-base with it.
    const step = w.step({ x: farUnits, z: 0 }, c);
    expect(step.changed).toBe(true);
    expect(step.rebase).not.toBeNull();
    w.dispose();
  });

  it('loads a ring beyond the visible rectangle so edge buildings survive', async () => {
    const w = await open();
    w.step({ x: 0, z: 0 }, corners(0, 0, 1));
    await flush();
    // A one-unit viewport still pulls in the halo, which is 128 m of ground.
    expect(w.stats().loaded).toBeGreaterThanOrEqual(1);
    expect(EDGE_HALO_METERS).toBe(128);
    w.dispose();
  });
});
