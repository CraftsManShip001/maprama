/**
 * Minimal PMTiles v3 writer (spec: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md).
 *
 * Written from the spec on purpose: the point of the spike is to show that a
 * PMTiles archive can carry *our* payload, not MVT. The output is verified by
 * reading it back with the official `pmtiles` npm package, which is the only
 * meaningful check that the bytes are right.
 *
 * Scope of this writer: a single root directory, no leaf directories. That is
 * fine up to a few tens of thousands of tiles; a nationwide archive needs the
 * two-level layout (see the spec doc, §5).
 */

import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { zxyToTileId } from 'pmtiles';

export const Compression = { Unknown: 0, None: 1, Gzip: 2, Brotli: 3, Zstd: 4 };
export const TileType = { Unknown: 0, Mvt: 1, Png: 2, Jpeg: 3, Webp: 4, Avif: 5 };

const HEADER_BYTES = 127;

function varint(value) {
  const out = [];
  let v = value;
  do {
    let byte = Number(v % 128n);
    v /= 128n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return Buffer.from(out);
}
const vi = (n) => varint(BigInt(n));

/**
 * Serialises directory entries, which must be sorted by `tileId`.
 * Entry: `{ tileId, offset, length, runLength }`.
 */
export function serializeDirectory(entries) {
  const parts = [vi(entries.length)];
  let last = 0;
  for (const e of entries) { parts.push(vi(e.tileId - last)); last = e.tileId; }
  for (const e of entries) parts.push(vi(e.runLength));
  for (const e of entries) parts.push(vi(e.length));
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const prev = entries[i - 1];
    if (i > 0 && prev.offset + prev.length === e.offset) parts.push(vi(0));
    else parts.push(vi(e.offset + 1));
  }
  return Buffer.concat(parts);
}

function buildHeader(h) {
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
  b.writeInt32LE(Math.round(h.minLon * 1e7), 102);
  b.writeInt32LE(Math.round(h.minLat * 1e7), 106);
  b.writeInt32LE(Math.round(h.maxLon * 1e7), 110);
  b.writeInt32LE(Math.round(h.maxLat * 1e7), 114);
  b.writeUInt8(h.centerZoom, 118);
  b.writeInt32LE(Math.round(h.centerLon * 1e7), 119);
  b.writeInt32LE(Math.round(h.centerLat * 1e7), 123);
  return b;
}

/**
 * Builds an archive.
 *
 * @param tiles   iterable of `{ z, x, y, bytes }` (uncompressed payloads)
 * @param options `{ metadata, bounds, center, tileType, tileCompression }`
 * @returns `{ buffer, stats }`
 */
export function writePMTiles(tiles, options) {
  const {
    metadata = {},
    bounds,
    center,
    tileType = TileType.Unknown,
    tileCompression = Compression.Gzip,
  } = options;

  const list = [...tiles].map((t) => ({
    ...t,
    tileId: Number(zxyToTileId(t.z, t.x, t.y)),
    body: tileCompression === Compression.Gzip ? gzipSync(t.bytes, { level: 9 }) : t.bytes,
  }));
  list.sort((a, b) => a.tileId - b.tileId);

  // deduplicate identical tile bodies (the spec's "tile contents" count)
  const byHash = new Map();
  const blobs = [];
  let dataLength = 0;
  const entries = [];
  for (const t of list) {
    const hash = createHash('sha256').update(t.body).digest('hex');
    let placed = byHash.get(hash);
    if (!placed) {
      placed = { offset: dataLength, length: t.body.length };
      byHash.set(hash, placed);
      blobs.push(t.body);
      dataLength += t.body.length;
    }
    const prev = entries[entries.length - 1];
    if (prev && prev.offset === placed.offset && prev.length === placed.length && prev.tileId + prev.runLength === t.tileId) {
      prev.runLength++;
    } else {
      entries.push({ tileId: t.tileId, offset: placed.offset, length: placed.length, runLength: 1 });
    }
  }

  const metaRaw = Buffer.from(JSON.stringify(metadata), 'utf8');
  const metaBytes = gzipSync(metaRaw, { level: 9 });
  const rootBytes = gzipSync(serializeDirectory(entries), { level: 9 });

  const rootOffset = HEADER_BYTES;
  const metadataOffset = rootOffset + rootBytes.length;
  const leafOffset = metadataOffset + metaBytes.length;
  const dataOffset = leafOffset; // no leaf directories

  const zooms = list.map((t) => t.z);
  const header = buildHeader({
    rootOffset,
    rootLength: rootBytes.length,
    metadataOffset,
    metadataLength: metaBytes.length,
    leafOffset,
    leafLength: 0,
    dataOffset,
    dataLength,
    addressedTiles: list.length,
    tileEntries: entries.length,
    tileContents: byHash.size,
    clustered: true,
    internalCompression: Compression.Gzip,
    tileCompression,
    tileType,
    minZoom: Math.min(...zooms),
    maxZoom: Math.max(...zooms),
    minLon: bounds.west,
    minLat: bounds.south,
    maxLon: bounds.east,
    maxLat: bounds.north,
    centerZoom: center.z,
    centerLon: center.lng,
    centerLat: center.lat,
  });

  return {
    buffer: Buffer.concat([header, rootBytes, metaBytes, ...blobs]),
    stats: {
      addressedTiles: list.length,
      tileEntries: entries.length,
      uniqueContents: byHash.size,
      rootDirectoryBytes: rootBytes.length,
      metadataBytes: metaBytes.length,
      tileDataBytes: dataLength,
      bytesPerDirectoryEntry: entries.length ? rootBytes.length / entries.length : 0,
    },
  };
}
