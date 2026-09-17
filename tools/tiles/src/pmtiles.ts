/**
 * A PMTiles v3 writer, written from the spec
 * (<https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md>), with
 * **leaf directories** — which the `tools/tile-spike` writer did not have and a
 * nationwide archive needs.
 *
 * Nothing here imports the `pmtiles` package: the Hilbert tile id, the
 * directory encoding and the 127-byte header are all implemented against the
 * spec. The package is a test-only dependency, so the round-trip check in
 * `test/pmtiles.test.ts` is a genuinely independent reader confirming the bytes.
 *
 * ## Why leaves
 *
 * A PMTiles client fetches the first 16 KiB of the file and expects the header,
 * the whole root directory and the metadata to be inside it. With ~110,000 z15
 * entries a single directory is ~54 KB compressed, so the root has to become an
 * index *of directories*: entries with `runLength = 0` whose offset/length point
 * into the leaf section. {@link buildDirectories} grows the leaf size until the
 * root fits, which is the same strategy `go-pmtiles` uses.
 *
 * ## Memory
 *
 * Tile bodies are streamed to a scratch file as they arrive and copied into the
 * final archive at the end, so a 1 GB archive costs one directory entry per tile
 * in memory (~110,000 small objects), not 1 GB.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { gzipSync } from 'node:zlib';
import type { GeoBounds } from './mercator.js';

/** PMTiles `internal_compression` / `tile_compression` values. */
export const Compression = { Unknown: 0, None: 1, Gzip: 2, Brotli: 3, Zstd: 4 } as const;
/** PMTiles `tile_type` values. MTIL uses `Unknown`, which the spec defines as "unconstrained". */
export const TileType = { Unknown: 0, Mvt: 1, Png: 2, Jpeg: 3, Webp: 4, Avif: 5 } as const;

/** The fixed PMTiles v3 header size. */
export const HEADER_BYTES = 127;
/**
 * Byte budget for header + root directory + metadata.
 *
 * The official reader's first request is `bytes=0-16383`; keeping all three
 * inside it is what makes a cold start one request instead of three.
 */
export const ROOT_BUDGET_BYTES = 16384;

/* ------------------------------------------------------------------ tile ids */

function rotate(n: number, xy: [number, number], rx: number, ry: number): void {
  if (ry !== 0) return;
  if (rx === 1) {
    xy[0] = n - 1 - xy[0];
    xy[1] = n - 1 - xy[1];
  }
  const t = xy[0];
  xy[0] = xy[1];
  xy[1] = t;
}

/**
 * The PMTiles v3 tile id of `z/x/y`: the zoom's base plus the tile's position on
 * the Hilbert curve of that zoom.
 *
 * The Hilbert order is what lets this pipeline work chunk by chunk: the
 * descendants of one low-zoom tile occupy a *contiguous* range of ids at every
 * deeper zoom, so tiles emitted chunk by chunk (chunks in id order) already come
 * out globally sorted, and the archive can be assembled in one streaming pass.
 */
export function zxyToTileId(z: number, x: number, y: number): number {
  if (z < 0 || z > 26) throw new RangeError(`zxyToTileId: zoom ${z} out of range`);
  const n = 2 ** z;
  if (x < 0 || y < 0 || x >= n || y >= n) throw new RangeError(`zxyToTileId: ${z}/${x}/${y} out of range`);
  let acc = 0;
  for (let tz = 0; tz < z; tz++) acc += 4 ** tz;
  const xy: [number, number] = [x, y];
  let d = 0;
  for (let s = n >> 1; s > 0; s >>= 1) {
    const rx = (xy[0] & s) > 0 ? 1 : 0;
    const ry = (xy[1] & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    rotate(s, xy, rx, ry);
  }
  return acc + d;
}

/* ---------------------------------------------------------------- directories */

/** One PMTiles directory entry. `runLength === 0` means "this is a leaf pointer". */
export interface Entry {
  tileId: number;
  offset: number;
  length: number;
  runLength: number;
}

function varint(value: number): number[] {
  const out: number[] = [];
  let x = value;
  do {
    let byte = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) byte |= 0x80;
    out.push(byte);
  } while (x > 0);
  return out;
}

/**
 * Serialises directory entries, which must already be sorted by `tileId`.
 *
 * The four columns (id deltas, run lengths, lengths, offsets) are written one
 * after another rather than interleaved, so each column gzips against itself.
 * An offset of `0` is the spec's "immediately after the previous entry" marker,
 * which is why a clustered archive's directory is under a byte per entry.
 */
export function serializeDirectory(entries: readonly Entry[]): Buffer {
  const out: number[] = varint(entries.length);
  let last = 0;
  for (const e of entries) {
    out.push(...varint(e.tileId - last));
    last = e.tileId;
  }
  for (const e of entries) out.push(...varint(e.runLength));
  for (const e of entries) out.push(...varint(e.length));
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const prev = entries[i - 1];
    if (i > 0 && prev && prev.offset + prev.length === e.offset) out.push(...varint(0));
    else out.push(...varint(e.offset + 1));
  }
  return Buffer.from(out);
}

/** The root/leaf split {@link buildDirectories} chose. */
export interface Directories {
  root: Buffer;
  leaves: Buffer;
  /** Entries per leaf; `0` when the archive needs no leaves. */
  leafSize: number;
  leafCount: number;
}

/**
 * Splits `entries` into a root directory that fits the budget plus, if needed,
 * leaf directories.
 *
 * Tries a single root first (small archives keep the one-request cold start with
 * no indirection at all), then doubles the entries-per-leaf until the root fits.
 */
export function buildDirectories(entries: readonly Entry[], budget: number = ROOT_BUDGET_BYTES): Directories {
  const gz = (b: Buffer): Buffer => gzipSync(b, { level: 9 });
  const flat = gz(serializeDirectory(entries));
  if (flat.length <= budget) return { root: flat, leaves: Buffer.alloc(0), leafSize: 0, leafCount: 0 };

  for (let leafSize = 4096; ; leafSize *= 2) {
    const rootEntries: Entry[] = [];
    const chunks: Buffer[] = [];
    let offset = 0;
    for (let i = 0; i < entries.length; i += leafSize) {
      const group = entries.slice(i, i + leafSize);
      const bytes = gz(serializeDirectory(group));
      rootEntries.push({ tileId: group[0]!.tileId, offset, length: bytes.length, runLength: 0 });
      chunks.push(bytes);
      offset += bytes.length;
    }
    const root = gz(serializeDirectory(rootEntries));
    if (root.length <= budget || leafSize >= entries.length) {
      return { root, leaves: Buffer.concat(chunks), leafSize, leafCount: chunks.length };
    }
  }
}

/* -------------------------------------------------------------------- header */

interface HeaderFields {
  rootOffset: number;
  rootLength: number;
  metadataOffset: number;
  metadataLength: number;
  leafOffset: number;
  leafLength: number;
  dataOffset: number;
  dataLength: number;
  addressedTiles: number;
  tileEntries: number;
  tileContents: number;
  clustered: boolean;
  internalCompression: number;
  tileCompression: number;
  tileType: number;
  minZoom: number;
  maxZoom: number;
  bounds: GeoBounds;
  centerZoom: number;
  center: { lng: number; lat: number };
}

function buildHeader(h: HeaderFields): Buffer {
  const b = Buffer.alloc(HEADER_BYTES);
  b.write('PMTiles', 0, 'ascii');
  b.writeUInt8(3, 7);
  b.writeBigUInt64LE(BigInt(h.rootOffset), 8);
  b.writeBigUInt64LE(BigInt(h.rootLength), 16);
  b.writeBigUInt64LE(BigInt(h.metadataOffset), 24);
  b.writeBigUInt64LE(BigInt(h.metadataLength), 32);
  b.writeBigUInt64LE(BigInt(h.leafOffset), 40);
  b.writeBigUInt64LE(BigInt(h.leafLength), 48);
  b.writeBigUInt64LE(BigInt(h.dataOffset), 56);
  b.writeBigUInt64LE(BigInt(h.dataLength), 64);
  b.writeBigUInt64LE(BigInt(h.addressedTiles), 72);
  b.writeBigUInt64LE(BigInt(h.tileEntries), 80);
  b.writeBigUInt64LE(BigInt(h.tileContents), 88);
  b.writeUInt8(h.clustered ? 1 : 0, 96);
  b.writeUInt8(h.internalCompression, 97);
  b.writeUInt8(h.tileCompression, 98);
  b.writeUInt8(h.tileType, 99);
  b.writeUInt8(h.minZoom, 100);
  b.writeUInt8(h.maxZoom, 101);
  b.writeInt32LE(Math.round(h.bounds.west * 1e7), 102);
  b.writeInt32LE(Math.round(h.bounds.south * 1e7), 106);
  b.writeInt32LE(Math.round(h.bounds.east * 1e7), 110);
  b.writeInt32LE(Math.round(h.bounds.north * 1e7), 114);
  b.writeUInt8(h.centerZoom, 118);
  b.writeInt32LE(Math.round(h.center.lng * 1e7), 119);
  b.writeInt32LE(Math.round(h.center.lat * 1e7), 123);
  return b;
}

/* -------------------------------------------------------------------- writer */

/** What {@link ArchiveWriter.finish} reports. */
export interface ArchiveStats {
  bytes: number;
  addressedTiles: number;
  tileEntries: number;
  uniqueContents: number;
  rootDirectoryBytes: number;
  leafDirectoryBytes: number;
  leafCount: number;
  leafSize: number;
  metadataBytes: number;
  tileDataBytes: number;
  minZoom: number;
  maxZoom: number;
}

/** Settings {@link ArchiveWriter.finish} needs that only the caller knows. */
export interface FinishOptions {
  metadata: unknown;
  bounds: GeoBounds;
  center: { lng: number; lat: number; z: number };
  tileType?: number;
  tileCompression?: number;
}

/**
 * Streams tiles into a PMTiles v3 archive.
 *
 * Tiles must be added in ascending `tileId` order — that is what `clustered = 1`
 * promises to the reader, and it is free here because the Hilbert curve makes
 * chunk-by-chunk emission already sorted.
 */
export class ArchiveWriter {
  #entries: Entry[] = [];
  #byHash = new Map<string, { offset: number; length: number }>();
  #dataLength = 0;
  #addressed = 0;
  #lastId = -1;
  #minZoom = Infinity;
  #maxZoom = -Infinity;
  #out: ReturnType<typeof createWriteStream> | null = null;

  /**
   * @param scratchPath where tile bodies are parked until the directories are
   *   known. Removed by {@link finish}.
   */
  constructor(readonly scratchPath: string) {}

  #stream(): ReturnType<typeof createWriteStream> {
    this.#out ??= createWriteStream(this.scratchPath);
    return this.#out;
  }

  /**
   * Appends one tile. `body` must already be compressed the way the header will
   * declare. Identical bodies are stored once, as the spec's
   * `num_tile_contents` intends.
   *
   * @returns whether the write buffer wants draining (`false` → await {@link drain}).
   */
  add(z: number, x: number, y: number, body: Buffer): boolean {
    const tileId = zxyToTileId(z, x, y);
    if (tileId <= this.#lastId) {
      throw new Error(`ArchiveWriter.add: tile ids must ascend (${tileId} after ${this.#lastId}, at ${z}/${x}/${y})`);
    }
    this.#lastId = tileId;
    if (z < this.#minZoom) this.#minZoom = z;
    if (z > this.#maxZoom) this.#maxZoom = z;
    this.#addressed++;

    const hash = createHash('sha256').update(body).digest('base64');
    let placed = this.#byHash.get(hash);
    let ok = true;
    if (!placed) {
      placed = { offset: this.#dataLength, length: body.length };
      this.#byHash.set(hash, placed);
      ok = this.#stream().write(body);
      this.#dataLength += body.length;
    }
    const prev = this.#entries[this.#entries.length - 1];
    if (prev && prev.offset === placed.offset && prev.length === placed.length && prev.tileId + prev.runLength === tileId) {
      prev.runLength++;
    } else {
      this.#entries.push({ tileId, offset: placed.offset, length: placed.length, runLength: 1 });
    }
    return ok;
  }

  /** Waits for the scratch stream to drain after {@link add} returned `false`. */
  async drain(): Promise<void> {
    const out = this.#out;
    if (!out) return;
    await new Promise<void>((resolve) => out.once('drain', () => resolve()));
  }

  /** Number of tiles added so far. */
  get count(): number {
    return this.#addressed;
  }

  /** Assembles the final archive at `outPath` and removes the scratch file. */
  async finish(outPath: string, options: FinishOptions): Promise<ArchiveStats> {
    const out = this.#stream();
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));

    const dirs = buildDirectories(this.#entries);
    const metaBytes = gzipSync(Buffer.from(JSON.stringify(options.metadata), 'utf8'), { level: 9 });

    const rootOffset = HEADER_BYTES;
    const metadataOffset = rootOffset + dirs.root.length;
    const leafOffset = metadataOffset + metaBytes.length;
    const dataOffset = leafOffset + dirs.leaves.length;

    const header = buildHeader({
      rootOffset,
      rootLength: dirs.root.length,
      metadataOffset,
      metadataLength: metaBytes.length,
      leafOffset,
      leafLength: dirs.leaves.length,
      dataOffset,
      dataLength: this.#dataLength,
      addressedTiles: this.#addressed,
      tileEntries: this.#entries.reduce((n, e) => n + (e.runLength > 0 ? 1 : 0), 0),
      tileContents: this.#byHash.size,
      clustered: true,
      internalCompression: Compression.Gzip,
      tileCompression: options.tileCompression ?? Compression.Gzip,
      tileType: options.tileType ?? TileType.Unknown,
      minZoom: this.#addressed > 0 ? this.#minZoom : 0,
      maxZoom: this.#addressed > 0 ? this.#maxZoom : 0,
      bounds: options.bounds,
      centerZoom: options.center.z,
      center: options.center,
    });

    const file = createWriteStream(outPath);
    const write = (b: Buffer): Promise<void> =>
      new Promise((resolve, reject) => file.write(b, (err) => (err ? reject(err) : resolve())));
    await write(header);
    await write(dirs.root);
    await write(metaBytes);
    if (dirs.leaves.length > 0) await write(dirs.leaves);
    if (this.#dataLength > 0) await pipeline(createReadStream(this.scratchPath), file, { end: false });
    await new Promise<void>((resolve, reject) => file.end((err?: Error | null) => (err ? reject(err) : resolve())));
    await rm(this.scratchPath, { force: true });

    const handle = await open(outPath, 'r');
    const bytes = (await handle.stat()).size;
    await handle.close();

    return {
      bytes,
      addressedTiles: this.#addressed,
      tileEntries: this.#entries.length,
      uniqueContents: this.#byHash.size,
      rootDirectoryBytes: dirs.root.length,
      leafDirectoryBytes: dirs.leaves.length,
      leafCount: dirs.leafCount,
      leafSize: dirs.leafSize,
      metadataBytes: metaBytes.length,
      tileDataBytes: this.#dataLength,
      minZoom: this.#addressed > 0 ? this.#minZoom : 0,
      maxZoom: this.#addressed > 0 ? this.#maxZoom : 0,
    };
  }
}
