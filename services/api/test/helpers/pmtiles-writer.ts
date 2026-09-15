/**
 * Builds tiny single-directory PMTiles v3 archives for tests
 * (spec: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md).
 */
import { gzipSync } from 'node:zlib';
import { zxyToTileId } from 'pmtiles';

export interface FixtureTile {
  z: number;
  x: number;
  y: number;
  data: Uint8Array;
}

export interface PmtilesFixtureOptions {
  tiles: FixtureTile[];
  metadata?: object;
  minZoom: number;
  maxZoom: number;
  bounds: [number, number, number, number];
  center: [number, number, number];
  /** 1 = none, 2 = gzip (default). */
  tileCompression?: 1 | 2;
  /** 1 = none, 2 = gzip (default). */
  internalCompression?: 1 | 2;
}

function varint(n: number, out: number[]): void {
  let v = n;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
}

export function buildPmtiles(opts: PmtilesFixtureOptions): Uint8Array {
  const tc = opts.tileCompression ?? 2;
  const ic = opts.internalCompression ?? 2;
  const entries = opts.tiles
    .map((t) => ({ tileId: zxyToTileId(t.z, t.x, t.y), data: tc === 2 ? new Uint8Array(gzipSync(t.data)) : t.data }))
    .sort((a, b) => a.tileId - b.tileId);

  let offset = 0;
  const placed = entries.map((e) => {
    const r = { tileId: e.tileId, offset, length: e.data.length };
    offset += e.data.length;
    return r;
  });

  const dir: number[] = [];
  varint(placed.length, dir);
  let lastId = 0;
  for (const e of placed) {
    varint(e.tileId - lastId, dir);
    lastId = e.tileId;
  }
  for (let i = 0; i < placed.length; i++) varint(1, dir);
  for (const e of placed) varint(e.length, dir);
  placed.forEach((e, i) => {
    const prev = placed[i - 1];
    varint(i > 0 && prev && e.offset === prev.offset + prev.length ? 0 : e.offset + 1, dir);
  });

  const maybeGzip = (b: Uint8Array): Uint8Array => (ic === 2 ? new Uint8Array(gzipSync(b)) : b);
  const root = maybeGzip(Uint8Array.from(dir));
  const meta = maybeGzip(new TextEncoder().encode(JSON.stringify(opts.metadata ?? {})));
  const tileData = new Uint8Array(offset);
  let p = 0;
  for (const e of entries) {
    tileData.set(e.data, p);
    p += e.data.length;
  }

  const HEADER = 127;
  const rootOff = HEADER;
  const metaOff = rootOff + root.length;
  const tileOff = metaOff + meta.length;
  const out = new Uint8Array(tileOff + tileData.length);
  const dv = new DataView(out.buffer);
  out.set(new TextEncoder().encode('PMTiles'), 0);
  dv.setUint8(7, 3);
  const u64 = (pos: number, v: number) => dv.setBigUint64(pos, BigInt(v), true);
  u64(8, rootOff);
  u64(16, root.length);
  u64(24, metaOff);
  u64(32, meta.length);
  u64(40, tileOff);
  u64(48, 0);
  u64(56, tileOff);
  u64(64, tileData.length);
  u64(72, entries.length);
  u64(80, entries.length);
  u64(88, entries.length);
  dv.setUint8(96, 1);
  dv.setUint8(97, ic);
  dv.setUint8(98, tc);
  dv.setUint8(99, 1); // MVT
  dv.setUint8(100, opts.minZoom);
  dv.setUint8(101, opts.maxZoom);
  const e7 = (pos: number, v: number) => dv.setInt32(pos, Math.round(v * 1e7), true);
  e7(102, opts.bounds[0]);
  e7(106, opts.bounds[1]);
  e7(110, opts.bounds[2]);
  e7(114, opts.bounds[3]);
  dv.setUint8(118, opts.center[2]);
  e7(119, opts.center[0]);
  e7(123, opts.center[1]);
  out.set(root, rootOff);
  out.set(meta, metaOff);
  out.set(tileData, tileOff);
  return out;
}
