/**
 * The driver: survey → plan → shard → assemble.
 *
 * ## Resumability
 *
 * A nationwide build is measured in hours, so it must never be an
 * all-or-nothing run. Every phase checkpoints into a work directory:
 *
 * - the node survey is cached (`survey.json`), because it is a full `.pbf` pass;
 * - the plan is written (`plan.json`) so a resumed run provably covers the same
 *   chunks in the same order;
 * - **each chunk's tiles are written to their own shard** (`shards/<id>.bin`)
 *   with the manifest written last, so a manifest on disk means that chunk is
 *   complete and a resumed run skips it. A chunk interrupted mid-write leaves a
 *   `.bin` with no manifest and is simply redone.
 *
 * Losing power therefore costs one chunk, not the run.
 *
 * ## Determinism
 *
 * Same input, same bytes. The plan is sorted by tile id, each chunk's tiles are
 * sorted by tile id, features keep source order, `encodeTile` is pure, gzip runs
 * at a fixed level, and the metadata JSON is built with a fixed key order. The
 * only thing that varies between runs is how chunks are grouped into batches,
 * and batching cannot change a chunk's output because every chunk is extracted
 * with its own padded bbox. `test/determinism.test.ts` pins this by building the
 * same region twice with different batch sizes.
 *
 * @module
 */

import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { batchChunks, planChunks, windowFor, type Chunk } from './chunks.js';
import { encodeTile } from './mtil.js';
import { ArchiveWriter, TileType, zxyToTileId, type ArchiveStats } from './pmtiles.js';
import {
  attributionIndices,
  attributionTable,
  composeRegion,
  tileAttribution,
  validateRouting,
  type LayerRouting,
  type TileSource,
} from './sources.js';
import { filterForOverview, tileBundle, type TileStats } from './tiler.js';
import { LAYER_NAMES, type GeoBundle } from './types.js';
import type { GeoBounds } from './mercator.js';

/** Default tile-local quantisation (§2.2): 0.118 m at z15. */
export const DEFAULT_EXTENT = 8192;
/** Default margin kept outside the tile edge (§3.2): 30 m at z15. */
export const DEFAULT_BUFFER = 256;

/** One zoom level of the archive and the profile applied at it. */
export interface Profile {
  zoom: number;
  /** `detail` stores everything; `overview` filters (§1.2). */
  name: 'detail' | 'overview';
}

/** The two levels `design/tile-format.md` §1.2 settled on. */
export const DEFAULT_PROFILES: Profile[] = [
  { zoom: 13, name: 'overview' },
  { zoom: 15, name: 'detail' },
];

/** Options for {@link buildArchive}. */
export interface BuildArchiveOptions {
  /** Where checkpoints live. Reusing it resumes. */
  workDir: string;
  /** Output `.pmtiles` path. */
  out: string;
  /** Archive name, written into the metadata. */
  name: string;
  /** Area to cover. */
  bounds: GeoBounds;
  sources: readonly TileSource[];
  routing: LayerRouting;
  /** Node counts per chunk cell (`surveyPbfNodes`). */
  survey: ReadonlyMap<string, number>;
  profiles?: Profile[];
  chunkZoom?: number;
  extent?: number;
  buffer?: number;
  padDeg?: number;
  /** Nodes per extraction batch. Bigger = fewer `.pbf` scans, more heap. */
  nodeBudget?: number;
  /** Chunks per extraction batch, whatever the node budget says. */
  maxChunksPerBatch?: number;
  log?: (message: string) => void;
}

/** Per-chunk checkpoint. */
interface ShardManifest {
  chunk: string;
  /** `[z, x, y, byteLength]` per tile, in archive order. */
  tiles: [number, number, number, number][];
  stats: Record<string, TileStats>;
}

/** What a build measured. */
export interface BuildReport {
  archive: ArchiveStats;
  chunksPlanned: number;
  chunksBuilt: number;
  chunksSkipped: number;
  batches: number;
  tilesPerZoom: Record<number, number>;
  bytesPerZoom: Record<number, number>;
  buildingOverflowUnits: number;
  seconds: number;
  attribution: string[];
}

const shardPaths = (workDir: string, id: string): { bin: string; manifest: string; tmp: string } => ({
  bin: join(workDir, 'shards', `${id}.bin`),
  manifest: join(workDir, 'shards', `${id}.json`),
  tmp: join(workDir, 'shards', `${id}.json.tmp`),
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds every tile of one chunk and writes its shard.
 *
 * Tiles come out ordered by PMTiles id within each zoom, and zooms ascend, which
 * is the order {@link assemble} can append without sorting anything.
 */
async function buildChunk(
  chunk: Chunk,
  geo: GeoBundle,
  options: Required<Pick<BuildArchiveOptions, 'workDir' | 'extent' | 'buffer'>> & {
    profiles: Profile[];
    routing: LayerRouting;
    indices: ReadonlyMap<string, number[]>;
  },
): Promise<ShardManifest> {
  const { bin, manifest, tmp } = shardPaths(options.workDir, chunk.id);
  const out = createWriteStream(bin);
  const tiles: ShardManifest['tiles'] = [];
  const stats: Record<string, TileStats> = {};

  for (const profile of options.profiles) {
    const input = profile.name === 'overview' ? filterForOverview(geo) : geo;
    const result = tileBundle(input, {
      zoom: profile.zoom,
      extent: options.extent,
      buffer: options.buffer,
      window: windowFor(chunk, profile.zoom),
      origin: options.routing,
    });
    stats[profile.name] = result.stats;
    const ordered = [...result.tiles.values()].sort(
      (a, b) => zxyToTileId(a.z, a.x, a.y) - zxyToTileId(b.z, b.x, b.y),
    );
    for (const t of ordered) {
      const body = gzipSync(
        encodeTile({
          extent: options.extent,
          buffer: options.buffer,
          attribution: tileAttribution(t.sources, options.indices),
          layers: t.layers,
        }),
        { level: 9 },
      );
      if (!out.write(body)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
      tiles.push([t.z, t.x, t.y, body.length]);
    }
  }
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));

  const payload: ShardManifest = { chunk: chunk.id, tiles, stats };
  // The manifest is the completion marker, so it is written last and renamed
  // into place: a half-written shard has no manifest and is simply rebuilt.
  await writeFile(tmp, JSON.stringify(payload));
  await rename(tmp, manifest);
  return payload;
}

/** Streams every shard into the archive, in plan order. */
async function assemble(
  chunks: readonly Chunk[],
  options: BuildArchiveOptions & { extent: number; buffer: number; profiles: Profile[]; attribution: string[] },
): Promise<{ stats: ArchiveStats; tilesPerZoom: Record<number, number>; bytesPerZoom: Record<number, number> }> {
  const writer = new ArchiveWriter(join(options.workDir, 'archive.data'));
  const tilesPerZoom: Record<number, number> = {};
  const bytesPerZoom: Record<number, number> = {};

  // Zooms ascend in the PMTiles id space, and within a zoom the descendants of a
  // chunk form a contiguous Hilbert range — so one pass per zoom over the chunks
  // in plan order is already globally sorted. `ArchiveWriter.add` throws if it
  // ever is not, which is the check that this reasoning holds.
  for (const profile of [...options.profiles].sort((a, b) => a.zoom - b.zoom)) {
    for (const chunk of chunks) {
      const { bin, manifest } = shardPaths(options.workDir, chunk.id);
      const raw = JSON.parse(await readFile(manifest, 'utf8')) as ShardManifest;
      const wanted = raw.tiles.filter((t) => t[0] === profile.zoom);
      if (wanted.length === 0) continue;
      // A shard holds its zooms one after another in the order they were built,
      // so the wanted zoom is one contiguous span starting after the earlier ones.
      let offset = 0;
      for (const t of raw.tiles) {
        if (t[0] === profile.zoom) break;
        offset += t[3];
      }
      const total = wanted.reduce((n, t) => n + t[3], 0);
      const buf = await readRange(bin, offset, total);
      let at = 0;
      for (const [z, x, y, len] of wanted) {
        const body = buf.subarray(at, at + len);
        at += len;
        if (!writer.add(z, x, y, Buffer.from(body))) await writer.drain();
        tilesPerZoom[z] = (tilesPerZoom[z] ?? 0) + 1;
        bytesPerZoom[z] = (bytesPerZoom[z] ?? 0) + len;
      }
    }
  }

  const zooms = options.profiles.map((p) => p.zoom);
  const stats = await writer.finish(options.out, {
    metadata: {
      format: 'maprama-mtil-1',
      name: options.name,
      extent: options.extent,
      buffer: options.buffer,
      attribution: options.attribution,
      layers: [...LAYER_NAMES],
      profiles: Object.fromEntries(options.profiles.map((p) => [String(p.zoom), p.name])),
    },
    bounds: options.bounds,
    center: {
      lng: (options.bounds.west + options.bounds.east) / 2,
      lat: (options.bounds.south + options.bounds.north) / 2,
      z: Math.max(...zooms),
    },
    tileType: TileType.Unknown,
  });
  return { stats, tilesPerZoom, bytesPerZoom };
}

async function readRange(path: string, offset: number, length: number): Promise<Buffer> {
  if (length === 0) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  for await (const chunk of createReadStream(path, { start: offset, end: offset + length - 1 })) {
    parts.push(chunk as Buffer);
  }
  return Buffer.concat(parts);
}

/** Runs the whole pipeline, resuming from whatever `workDir` already holds. */
export async function buildArchive(options: BuildArchiveOptions): Promise<BuildReport> {
  const log = options.log ?? ((): void => {});
  const extent = options.extent ?? DEFAULT_EXTENT;
  const buffer = options.buffer ?? DEFAULT_BUFFER;
  const profiles = options.profiles ?? DEFAULT_PROFILES;
  validateRouting(options.sources, options.routing);

  const started = Date.now();
  await mkdir(join(options.workDir, 'shards'), { recursive: true });

  const chunks = planChunks({
    bounds: options.bounds,
    survey: options.survey,
    ...(options.chunkZoom !== undefined ? { chunkZoom: options.chunkZoom } : {}),
    ...(options.padDeg !== undefined ? { padDeg: options.padDeg } : {}),
  });
  await writeFile(
    join(options.workDir, 'plan.json'),
    JSON.stringify({ chunkZoom: chunks[0]?.cz ?? options.chunkZoom ?? 10, chunks: chunks.map((c) => c.id) }),
  );

  const attribution = attributionTable(options.sources, options.routing);
  const indices = attributionIndices(options.sources, options.routing);

  const pending: Chunk[] = [];
  let skipped = 0;
  for (const chunk of chunks) {
    if (await exists(shardPaths(options.workDir, chunk.id).manifest)) skipped++;
    else pending.push(chunk);
  }
  log(`plan: ${chunks.length} chunks (${skipped} already done, ${pending.length} to build)`);

  const batches = batchChunks(pending, options.nodeBudget ?? 6_000_000, options.maxChunksPerBatch ?? 64);
  let overflow = 0;
  let built = 0;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    const t0 = Date.now();
    for (const source of options.sources) await source.prepare?.(batch);
    for (const chunk of batch) {
      const geo = await composeRegion(options.sources, options.routing, chunk);
      const manifest = await buildChunk(chunk, geo, {
        workDir: options.workDir,
        extent,
        buffer,
        profiles,
        routing: options.routing,
        indices,
      });
      for (const s of Object.values(manifest.stats)) overflow = Math.max(overflow, s.buildingOverflowUnits);
      built++;
    }
    for (const source of options.sources) source.release?.();
    log(
      `batch ${i + 1}/${batches.length}: ${batch.length} chunks in ${((Date.now() - t0) / 1000).toFixed(1)} s ` +
        `(${built}/${pending.length} built, rss ${(process.memoryUsage.rss() / 2 ** 20).toFixed(0)} MiB)`,
    );
  }

  const { stats, tilesPerZoom, bytesPerZoom } = await assemble(chunks, {
    ...options,
    extent,
    buffer,
    profiles,
    attribution,
  });

  return {
    archive: stats,
    chunksPlanned: chunks.length,
    chunksBuilt: built,
    chunksSkipped: skipped,
    batches: batches.length,
    tilesPerZoom,
    bytesPerZoom,
    buildingOverflowUnits: overflow,
    seconds: (Date.now() - started) / 1000,
    attribution,
  };
}

/** Removes a work directory's shards, for a forced rebuild. */
export async function clearWork(workDir: string): Promise<void> {
  await rm(join(workDir, 'shards'), { recursive: true, force: true });
}

export { planChunks, batchChunks, windowFor };
