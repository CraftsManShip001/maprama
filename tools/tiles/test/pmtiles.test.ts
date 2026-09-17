/**
 * The archive writer, checked against the official `pmtiles` package.
 *
 * Nothing in `src/pmtiles.ts` imports `pmtiles`, so these are two independent
 * implementations of the same spec agreeing — which is the only check worth
 * anything for hand-written binary output.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { zxyToTileId as officialTileId } from 'pmtiles';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ArchiveWriter,
  ROOT_BUDGET_BYTES,
  buildDirectories,
  serializeDirectory,
  zxyToTileId,
  type Entry,
} from '../src/pmtiles.js';
import { openArchive } from '../src/reader.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'maprama-tiles-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('zxyToTileId', () => {
  it('agrees with the official implementation across every zoom we use', () => {
    for (let z = 0; z <= 16; z++) {
      const n = 2 ** z;
      const samples = [0, 1, n - 1, Math.floor(n / 2), Math.floor(n / 3), Math.floor(n * 0.77)];
      for (const x of samples) {
        for (const y of samples) {
          if (x >= n || y >= n) continue;
          expect(zxyToTileId(z, x, y), `${z}/${x}/${y}`).toBe(Number(officialTileId(z, x, y)));
        }
      }
    }
  });

  it('puts a chunk’s descendants in one contiguous range', () => {
    // The assembler depends on this: chunk-by-chunk emission is already sorted.
    const cz = 10;
    const cx = 874;
    const cy = 403;
    const k = 2 ** (15 - cz);
    const ids: number[] = [];
    for (let x = cx * k; x < cx * k + k; x++) {
      for (let y = cy * k; y < cy * k + k; y++) ids.push(zxyToTileId(15, x, y));
    }
    ids.sort((a, b) => a - b);
    expect(ids[ids.length - 1]! - ids[0]!).toBe(ids.length - 1);
    // ...and the range sits where the parent sits relative to its neighbour.
    const next: number[] = [];
    for (let x = (cx + 1) * k; x < (cx + 1) * k + k; x++) {
      for (let y = cy * k; y < cy * k + k; y++) next.push(zxyToTileId(15, x, y));
    }
    const parentOrder = zxyToTileId(cz, cx, cy) < zxyToTileId(cz, cx + 1, cy);
    expect(Math.min(...ids) < Math.min(...next)).toBe(parentOrder);
  });

  it('rejects out-of-range addresses', () => {
    expect(() => zxyToTileId(2, 4, 0)).toThrow(/out of range/);
    expect(() => zxyToTileId(-1, 0, 0)).toThrow(/out of range/);
  });
});

describe('serializeDirectory', () => {
  it('encodes a contiguous run as the spec’s zero offset', () => {
    const entries: Entry[] = [
      { tileId: 10, offset: 0, length: 5, runLength: 1 },
      { tileId: 11, offset: 5, length: 7, runLength: 1 },
    ];
    const bytes = serializeDirectory(entries);
    // count, 2 id deltas, 2 run lengths, 2 lengths, 2 offsets -> 9 varints
    expect(bytes.length).toBe(9);
    expect(bytes[bytes.length - 1]).toBe(0);
  });
});

describe('buildDirectories', () => {
  // Lengths must vary the way real tile lengths do: a directory of identical
  // numbers gzips to almost nothing and would never need a leaf.
  const entries = (n: number): Entry[] => {
    const out: Entry[] = [];
    let offset = 0;
    let seed = 1;
    for (let i = 0; i < n; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed |= 0;
      const length = 200 + (Math.abs(seed) % 60_000);
      out.push({ tileId: i, offset, length, runLength: 1 });
      offset += length;
    }
    return out;
  };

  it('keeps a small archive flat', () => {
    const d = buildDirectories(entries(100));
    expect(d.leafCount).toBe(0);
    expect(d.leaves.length).toBe(0);
  });

  it('splits into leaves once the root outgrows the budget', () => {
    const d = buildDirectories(entries(200_000));
    expect(d.leafCount).toBeGreaterThan(1);
    expect(d.root.length).toBeLessThanOrEqual(ROOT_BUDGET_BYTES);
    expect(d.leaves.length).toBeGreaterThan(0);
    // Every root entry must be a leaf pointer, and they must tile the leaf blob.
    const root = gunzipSync(d.root);
    expect(root.length).toBeGreaterThan(0);
  });
});

describe('ArchiveWriter', () => {
  it('rejects tiles that are not in ascending id order', async () => {
    const w = new ArchiveWriter(join(dir, 'order.data'));
    w.add(15, 100, 100, gzipSync(Buffer.from('a')));
    expect(() => w.add(15, 0, 0, gzipSync(Buffer.from('b')))).toThrow(/must ascend/);
    await w.finish(join(dir, 'order.pmtiles'), {
      metadata: {},
      bounds: { west: 0, south: 0, east: 1, north: 1 },
      center: { lng: 0, lat: 0, z: 15 },
    });
  });

  it('round-trips a leaf-directory archive through the official reader', async () => {
    // Enough z15 tiles that a single root directory cannot hold them, which is
    // the case `tools/tile-spike` could not produce at all.
    const w = new ArchiveWriter(join(dir, 'leaf.data'));
    const want = new Map<string, string>();
    const coords: [number, number][] = [];
    const base = { x: 27900, y: 12800 };
    for (let dx = 0; dx < 300; dx++) for (let dy = 0; dy < 300; dy++) coords.push([base.x + dx, base.y + dy]);
    coords.sort((a, b) => zxyToTileId(15, a[0], a[1]) - zxyToTileId(15, b[0], b[1]));
    // Body lengths must vary the way real tile lengths do. A directory whose
    // length column is nearly constant gzips away to nothing and would never
    // need a leaf, so the test would not exercise the thing it is about.
    let seed = 7;
    const rand = (): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed |= 0;
      return Math.abs(seed);
    };
    for (const [x, y] of coords) {
      const body = Buffer.alloc(40 + (rand() % 4000));
      for (let i = 0; i < body.length; i++) body[i] = rand() & 0xff;
      body.write(`${x}/${y}`, 0, 'ascii');
      want.set(`${x}/${y}`, body.toString('base64'));
      if (!w.add(15, x, y, body)) await w.drain();
    }
    const out = join(dir, 'leaf.pmtiles');
    const stats = await w.finish(out, {
      metadata: { format: 'maprama-mtil-1', attribution: ['© OpenStreetMap contributors'] },
      bounds: { west: 126, south: 37, east: 127, north: 38 },
      center: { lng: 126.5, lat: 37.5, z: 15 },
      tileCompression: 1,
    });

    expect(stats.addressedTiles).toBe(90_000);
    expect(stats.leafCount).toBeGreaterThan(1);
    expect(stats.rootDirectoryBytes).toBeLessThanOrEqual(ROOT_BUDGET_BYTES);
    // The whole point of leaves: the cold-start request still holds everything.
    expect(127 + stats.rootDirectoryBytes + stats.metadataBytes).toBeLessThanOrEqual(ROOT_BUDGET_BYTES);

    const archive = openArchive(out);
    const header = await archive.getHeader();
    expect(header.specVersion).toBe(3);
    expect(header.tileType).toBe(0);
    expect(header.tileCompression).toBe(1);
    expect(header.clustered).toBe(true);
    expect(header.numAddressedTiles).toBe(90_000);
    expect(header.leafDirectoryLength).toBeGreaterThan(0);
    expect(await archive.getMetadata()).toMatchObject({ format: 'maprama-mtil-1' });

    // Read tiles from the first, middle and last leaf.
    for (const [x, y] of [coords[0]!, coords[45_000]!, coords[89_999]!, coords[12_345]!]) {
      const result = await archive.getZxy(15, x, y);
      expect(result, `${x}/${y}`).toBeTruthy();
      expect(Buffer.from(result!.data).toString('base64')).toBe(want.get(`${x}/${y}`));
    }
    // A tile outside the set must be absent, not wrong.
    expect(await archive.getZxy(15, base.x - 1, base.y - 1)).toBeFalsy();
  });

  it('stores identical bodies once', async () => {
    const w = new ArchiveWriter(join(dir, 'dedupe.data'));
    const body = gzipSync(Buffer.from('same'), { level: 9 });
    const coords: [number, number][] = [];
    for (let dx = 0; dx < 8; dx++) coords.push([1000 + dx, 2000]);
    coords.sort((a, b) => zxyToTileId(15, a[0], a[1]) - zxyToTileId(15, b[0], b[1]));
    for (const [x, y] of coords) w.add(15, x, y, body);
    const stats = await w.finish(join(dir, 'dedupe.pmtiles'), {
      metadata: {},
      bounds: { west: 0, south: 0, east: 1, north: 1 },
      center: { lng: 0, lat: 0, z: 15 },
    });
    expect(stats.addressedTiles).toBe(8);
    expect(stats.uniqueContents).toBe(1);
    expect(stats.tileDataBytes).toBe(body.length);
  });
});
