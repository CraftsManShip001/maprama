/**
 * The driver: determinism, resumability, chunk planning, and the per-layer
 * source routing that the national-building swap will use.
 *
 * The source here is synthetic, so these tests run in milliseconds and pin the
 * behaviour that a five-hour `.pbf` run cannot be a test of.
 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batchChunks, planChunks, windowFor } from '../src/chunks.js';
import { buildArchive, clearWork } from '../src/build.js';
import { openArchive, readTile } from '../src/reader.js';
import {
  attributionIndices,
  attributionTable,
  composeRegion,
  tileAttribution,
  validateRouting,
  type LayerRouting,
  type Region,
  type TileSource,
} from '../src/sources.js';
import { emptyBundle, LAYER_NAMES, type GeoBundle, type LayerName } from '../src/types.js';
import type { GeoBounds } from '../src/mercator.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'maprama-tiles-build-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A deterministic pseudo-source: features derived from the region's own bounds. */
class FakeSource implements TileSource {
  readonly provides: readonly LayerName[];
  prepared: Region[][] = [];

  constructor(
    readonly id: string,
    readonly attribution: readonly string[],
    readonly only?: readonly LayerName[],
  ) {
    this.provides = only ?? LAYER_NAMES;
  }

  async prepare(regions: readonly Region[]): Promise<void> {
    this.prepared.push([...regions]);
  }

  async load(region: Region): Promise<GeoBundle> {
    const geo = emptyBundle();
    const b = region.padded;
    const w = b.east - b.west;
    const h = b.north - b.south;
    for (let i = 0; i < 12; i++) {
      const fx = 0.08 + (i % 4) * 0.25;
      const fy = 0.08 + Math.floor(i / 4) * 0.3;
      const lng = b.west + w * fx;
      const lat = b.south + h * fy;
      geo.buildings.push({
        id: `${this.id}-${region.id}-${i}`,
        heightDm: 200 + i * 37,
        footprint: [
          [lng, lat],
          [lng + w * 0.02, lat],
          [lng + w * 0.02, lat + h * 0.02],
          [lng, lat + h * 0.02],
        ],
      });
      geo.roads.push({
        id: `${this.id}-${region.id}-r${i}`,
        cls: i % 3 === 0 ? 'arterial' : 'local',
        pts: [
          [b.west, lat],
          [b.east, lat],
        ],
      });
    }
    geo.water.push({
      poly: [
        [b.west, b.south + h * 0.45],
        [b.east, b.south + h * 0.45],
        [b.east, b.south + h * 0.55],
        [b.west, b.south + h * 0.55],
      ],
    });
    if (this.only) {
      const out = emptyBundle();
      for (const layer of this.only) (out[layer] as unknown[]) = geo[layer];
      return out;
    }
    return geo;
  }
}

const bounds: GeoBounds = { west: 126.9, south: 37.45, east: 127.1, north: 37.6 };
const survey = new Map<string, number>();
{
  // Mark the cells covering `bounds` at z12 as non-empty.
  const n = 2 ** 12;
  const merc = (lat: number): number => {
    const s = Math.sin((lat * Math.PI) / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  };
  for (let x = Math.floor(((bounds.west + 180) / 360) * n); x <= Math.floor(((bounds.east + 180) / 360) * n); x++) {
    for (let y = Math.floor(merc(bounds.north) * n); y <= Math.floor(merc(bounds.south) * n); y++) {
      survey.set(`${x}/${y}`, 100_000);
    }
  }
}

const routing: LayerRouting = Object.fromEntries(LAYER_NAMES.map((l) => [l, 'osm'])) as LayerRouting;

async function build(workDir: string, out: string, nodeBudget: number): Promise<Buffer> {
  await buildArchive({
    workDir: join(dir, workDir),
    out: join(dir, out),
    name: 'Test',
    bounds,
    sources: [new FakeSource('osm', ['© OpenStreetMap contributors'])],
    routing,
    survey,
    chunkZoom: 12,
    profiles: [
      { zoom: 13, name: 'overview' },
      { zoom: 15, name: 'detail' },
    ],
    nodeBudget,
  });
  return readFile(join(dir, out));
}

describe('determinism', () => {
  it('produces byte-identical archives across runs and across batch sizes', async () => {
    const a = await build('det-a', 'det-a.pmtiles', 10_000_000);
    const b = await build('det-b', 'det-b.pmtiles', 10_000_000);
    expect(a.equals(b)).toBe(true);

    // Batching is a scheduling decision; it must not reach the bytes. A tiny
    // budget forces one chunk per batch instead of all of them together.
    const c = await build('det-c', 'det-c.pmtiles', 1);
    expect(c.equals(a)).toBe(true);
  });
});

describe('resume', () => {
  it('skips chunks that already have a shard and still writes the same archive', async () => {
    const workDir = join(dir, 'resume');
    const out = join(dir, 'resume.pmtiles');
    const run = async (): Promise<Awaited<ReturnType<typeof buildArchive>>> =>
      buildArchive({
        workDir,
        out,
        name: 'Test',
        bounds,
        sources: [new FakeSource('osm', ['© OpenStreetMap contributors'])],
        routing,
        survey,
        chunkZoom: 12,
        profiles: [{ zoom: 15, name: 'detail' }],
      });

    const first = await run();
    expect(first.chunksBuilt).toBeGreaterThan(0);
    expect(first.chunksSkipped).toBe(0);
    const bytes = await readFile(out);

    const second = await run();
    expect(second.chunksBuilt).toBe(0);
    expect(second.chunksSkipped).toBe(first.chunksPlanned);
    expect((await readFile(out)).equals(bytes)).toBe(true);

    // Simulate a crash: drop one chunk's manifest, keep its half-written data.
    const shards = join(workDir, 'shards');
    const manifest = (await readdir(shards)).find((f) => f.endsWith('.json'))!;
    await rm(join(shards, manifest));
    const third = await run();
    expect(third.chunksBuilt).toBe(1);
    expect((await readFile(out)).equals(bytes)).toBe(true);

    await clearWork(workDir);
    expect((await readdir(workDir)).includes('shards')).toBe(false);
  });
});

describe('archive contents', () => {
  it('is readable by the official reader and carries attribution on every tile', async () => {
    const out = join(dir, 'contents.pmtiles');
    const report = await buildArchive({
      workDir: join(dir, 'contents'),
      out,
      name: 'Test',
      bounds,
      sources: [new FakeSource('osm', ['© OpenStreetMap contributors'])],
      routing,
      survey,
      chunkZoom: 12,
    });
    expect(report.archive.addressedTiles).toBeGreaterThan(0);
    expect(report.tilesPerZoom[15]).toBeGreaterThan(0);
    expect(report.tilesPerZoom[13]).toBeGreaterThan(0);

    const archive = openArchive(out);
    const header = await archive.getHeader();
    expect(header.minZoom).toBe(13);
    expect(header.maxZoom).toBe(15);
    const metadata = (await archive.getMetadata()) as { format: string; attribution: string[]; layers: string[] };
    expect(metadata.format).toBe('maprama-mtil-1');
    expect(metadata.attribution).toEqual(['© OpenStreetMap contributors']);
    expect(metadata.layers).toEqual([...LAYER_NAMES]);

    // Find a stored tile and check it decodes with an attribution index.
    const n = 2 ** 15;
    const s = Math.sin((37.5 * Math.PI) / 180);
    const x = Math.floor(((127.0 + 180) / 360) * n);
    const y = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
    let found = 0;
    for (let dx = -2; dx <= 2 && found < 3; dx++) {
      for (let dy = -2; dy <= 2 && found < 3; dy++) {
        const tile = await readTile(archive, 15, x + dx, y + dy);
        if (!tile) continue;
        found++;
        expect(tile.attribution).toEqual([0]);
        expect(tile.extent).toBe(8192);
      }
    }
    expect(found).toBeGreaterThan(0);
  });
});

describe('layer routing', () => {
  const osm = new FakeSource('osm', ['© OpenStreetMap contributors']);
  const kr = new FakeSource('kr', ['건물: 국가공간정보포털'], ['buildings']);
  const split: LayerRouting = { ...routing, buildings: 'kr' };

  it('rejects a routing that names an unknown or incapable source', () => {
    expect(() => validateRouting([osm], split)).toThrow(/unknown source "kr"/);
    expect(() => validateRouting([osm, new FakeSource('kr', [], [])], split)).toThrow(/does not provide/);
  });

  it('builds the attribution table from the sources a routing actually uses', () => {
    expect(attributionTable([osm, kr], routing)).toEqual(['© OpenStreetMap contributors']);
    expect(attributionTable([osm, kr], split)).toEqual([
      '© OpenStreetMap contributors',
      '건물: 국가공간정보포털',
    ]);
    const indices = attributionIndices([osm, kr], split);
    expect(indices.get('osm')).toEqual([0]);
    expect(indices.get('kr')).toEqual([1]);
    // A tile with only OSM layers says so; one with a national building says both.
    expect(tileAttribution(['osm'], indices)).toEqual([0]);
    expect(tileAttribution(['kr', 'osm'], indices)).toEqual([0, 1]);
  });

  it('takes each layer from the source it is routed to', async () => {
    const region: Region = { id: 'r', core: bounds, padded: bounds };
    const geo = await composeRegion([osm, kr], split, region);
    expect(geo.buildings[0]!.id.startsWith('kr-')).toBe(true);
    expect(geo.roads[0]!.id.startsWith('osm-')).toBe(true);
  });
});

describe('chunk planning', () => {
  it('skips cells the survey found empty and orders by tile id', () => {
    const chunks = planChunks({ bounds, survey, chunkZoom: 12 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks).toEqual([...chunks].sort((a, b) => a.tileId - b.tileId));
    const thin = new Map<string, number>([[[...survey.keys()][0]!, 5]]);
    const sparse = planChunks({ bounds, survey: thin, chunkZoom: 12, minNodes: 10 });
    expect(sparse).toHaveLength(0);
  });

  it('pads each chunk beyond what it owns', () => {
    const [chunk] = planChunks({ bounds, survey, chunkZoom: 12 });
    expect(chunk!.padded.west).toBeLessThan(chunk!.core.west);
    expect(chunk!.padded.north).toBeGreaterThan(chunk!.core.north);
  });

  it('maps a chunk onto exactly the tiles it owns', () => {
    const w = windowFor({ cz: 10, cx: 5, cy: 7 }, 15);
    expect(w).toEqual({ x0: 160, x1: 191, y0: 224, y1: 255 });
    expect(() => windowFor({ cz: 10, cx: 5, cy: 7 }, 9)).toThrow(/coarser/);
  });

  it('packs batches under the node budget but never drops a chunk', () => {
    const chunks = planChunks({ bounds, survey, chunkZoom: 12 });
    const batches = batchChunks(chunks, 1);
    expect(batches.flat()).toHaveLength(chunks.length);
    expect(batches).toHaveLength(chunks.length);
    expect(batchChunks(chunks, 1e12)).toHaveLength(1);
    expect(batchChunks(chunks, 1e12, 2).every((b) => b.length <= 2)).toBe(true);
  });
});
