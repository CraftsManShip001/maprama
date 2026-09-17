/**
 * `MTIL` v1: the bytes one PMTiles tile holds. The layout is fixed by
 * `design/tile-format.md` §4.4 and must not drift — the engine decodes it.
 *
 * ```
 *   magic      "MTIL"                        4 B
 *   version    u8 = 1
 *   flags      u8   bit0 = geometry is clipped to the tile + buffer
 *   extent     u16  tile-local units per tile edge (e.g. 8192)
 *   buffer     u16  units of geometry kept outside the tile edge
 *   attr       varint n, then n × varint     indices into the archive metadata
 *                                            `attribution` string table
 *   layers     varint n, then n × layer
 *   layer      u8 id, varint byteLength, bytes
 * ```
 *
 * `byteLength` on every layer is what makes the format forward-compatible: a
 * reader that does not know a layer id skips it.
 *
 * Geometry is a cursor stream (MVT-style): each vertex is a zigzag-varint delta
 * from the previous vertex, and a feature's first vertex is a delta from the
 * previous feature's last vertex. Coordinates are tile-local integers; they may
 * be negative or exceed `extent` by up to `buffer`.
 *
 * **Determinism.** Encoding is a pure function of the layer contents: layers are
 * written in fixed id order, features in the order given, and nothing here reads
 * a clock, a hash seed or a `Map` iteration order. `buildArchive` relies on that
 * to guarantee same input → same bytes.
 *
 * @module
 */

import { BUILDING_KINDS, POI_CATEGORIES, ROAD_CLASSES } from '@maprama/protocol';
import type { Pt } from './geometry.js';
import { LAYER_BY_ID, LAYER_ID, LAYER_NAMES, emptyLayers, type LayerName, type TileLayers } from './types.js';

/** MTIL magic bytes. */
export const MAGIC = Buffer.from('MTIL', 'ascii');
/** Format version this module writes and reads. */
export const MTIL_VERSION = 1;
/** `flags` bit 0: geometry is clipped to the tile plus the buffer. */
export const FLAG_CLIPPED = 0x01;

/* ---------------------------------------------------------------- primitives */

class Writer {
  buf = Buffer.alloc(1 << 16);
  len = 0;

  private need(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = Buffer.alloc(size);
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }

  u8(v: number): void {
    this.need(1);
    this.buf[this.len++] = v & 0xff;
  }

  u16(v: number): void {
    this.need(2);
    this.buf.writeUInt16LE(v, this.len);
    this.len += 2;
  }

  varint(v: number): void {
    this.need(10);
    let x = v;
    do {
      let byte = x & 0x7f;
      x = Math.floor(x / 128);
      if (x > 0) byte |= 0x80;
      this.buf[this.len++] = byte;
    } while (x > 0);
  }

  svarint(v: number): void {
    this.varint(v < 0 ? -2 * v - 1 : 2 * v);
  }

  string(s: string): void {
    const b = Buffer.from(s, 'utf8');
    this.varint(b.length);
    this.need(b.length);
    b.copy(this.buf, this.len);
    this.len += b.length;
  }

  bytes(b: Buffer): void {
    this.varint(b.length);
    this.need(b.length);
    b.copy(this.buf, this.len);
    this.len += b.length;
  }

  done(): Buffer {
    return this.buf.subarray(0, this.len);
  }
}

class Reader {
  pos = 0;
  constructor(readonly buf: Buffer) {}

  u8(): number {
    return this.buf[this.pos++]!;
  }

  u16(): number {
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  varint(): number {
    let result = 0;
    let shift = 1;
    let byte = 0;
    do {
      byte = this.buf[this.pos++]!;
      result += (byte & 0x7f) * shift;
      shift *= 128;
    } while (byte & 0x80);
    return result;
  }

  svarint(): number {
    const v = this.varint();
    return v & 1 ? -(v + 1) / 2 : v / 2;
  }

  string(): string {
    const n = this.varint();
    const s = this.buf.toString('utf8', this.pos, this.pos + n);
    this.pos += n;
    return s;
  }

  sub(n: number): Buffer {
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
}

interface Cursor {
  u: number;
  v: number;
}

function writeGeom(w: Writer, pts: readonly Pt[], c: Cursor): void {
  w.varint(pts.length);
  for (const [u, v] of pts) {
    w.svarint(u - c.u);
    w.svarint(v - c.v);
    c.u = u;
    c.v = v;
  }
}

function readGeom(r: Reader, c: Cursor): Pt[] {
  const n = r.varint();
  const pts: Pt[] = new Array(n);
  for (let i = 0; i < n; i++) {
    c.u += r.svarint();
    c.v += r.svarint();
    pts[i] = [c.u, c.v];
  }
  return pts;
}

/* -------------------------------------------------------------------- layers */

interface Codec {
  encode(w: Writer, features: readonly unknown[]): void;
  decode(r: Reader): unknown[];
}

const codecs: Record<LayerName, Codec> = {
  roads: {
    encode(w, features) {
      w.varint(features.length);
      const c: Cursor = { u: 0, v: 0 };
      for (const raw of features) {
        const f = raw as TileLayers['roads'][number];
        w.string(f.id);
        let flags = ROAD_CLASSES.indexOf(f.cls);
        if (f.name !== undefined) flags |= 0x04;
        if (f.bridge) flags |= 0x08;
        w.u8(flags);
        if (f.name !== undefined) w.string(f.name);
        writeGeom(w, f.pts, c);
      }
    },
    decode(r) {
      const n = r.varint();
      const out: unknown[] = new Array(n);
      const c: Cursor = { u: 0, v: 0 };
      for (let i = 0; i < n; i++) {
        const id = r.string();
        const flags = r.u8();
        const f: Record<string, unknown> = { id, cls: ROAD_CLASSES[flags & 0x03] };
        if (flags & 0x04) f['name'] = r.string();
        if (flags & 0x08) f['bridge'] = true;
        f['pts'] = readGeom(r, c);
        out[i] = f;
      }
      return out;
    },
  },
  buildings: {
    encode(w, features) {
      w.varint(features.length);
      const c: Cursor = { u: 0, v: 0 };
      for (const raw of features) {
        const f = raw as TileLayers['buildings'][number];
        w.string(f.id);
        let flags = 0;
        if (f.name !== undefined) flags |= 0x01;
        if (f.levels !== undefined) flags |= 0x02;
        if (f.kind !== undefined) flags |= 0x04;
        w.u8(flags);
        w.varint(f.heightDm);
        if (f.levels !== undefined) w.varint(f.levels);
        if (f.kind !== undefined) w.u8(BUILDING_KINDS.indexOf(f.kind));
        if (f.name !== undefined) w.string(f.name);
        writeGeom(w, f.footprint, c);
      }
    },
    decode(r) {
      const n = r.varint();
      const out: unknown[] = new Array(n);
      const c: Cursor = { u: 0, v: 0 };
      for (let i = 0; i < n; i++) {
        const id = r.string();
        const flags = r.u8();
        const f: Record<string, unknown> = { id, heightDm: r.varint() };
        if (flags & 0x02) f['levels'] = r.varint();
        if (flags & 0x04) f['kind'] = BUILDING_KINDS[r.u8()];
        if (flags & 0x01) f['name'] = r.string();
        f['footprint'] = readGeom(r, c);
        out[i] = f;
      }
      return out;
    },
  },
  water: {
    encode(w, features) {
      w.varint(features.length);
      const c: Cursor = { u: 0, v: 0 };
      for (const raw of features) writeGeom(w, (raw as TileLayers['water'][number]).poly, c);
    },
    decode(r) {
      const n = r.varint();
      const out: unknown[] = new Array(n);
      const c: Cursor = { u: 0, v: 0 };
      for (let i = 0; i < n; i++) out[i] = { poly: readGeom(r, c) };
      return out;
    },
  },
  parks: {
    encode(w, features) {
      w.varint(features.length);
      const c: Cursor = { u: 0, v: 0 };
      for (const raw of features) {
        const f = raw as TileLayers['parks'][number];
        w.u8(f.name !== undefined ? 1 : 0);
        if (f.name !== undefined) w.string(f.name);
        writeGeom(w, f.poly, c);
      }
    },
    decode(r) {
      const n = r.varint();
      const out: unknown[] = new Array(n);
      const c: Cursor = { u: 0, v: 0 };
      for (let i = 0; i < n; i++) {
        const f: Record<string, unknown> = {};
        if (r.u8()) f['name'] = r.string();
        f['poly'] = readGeom(r, c);
        out[i] = f;
      }
      return out;
    },
  },
  pois: {
    encode(w, features) {
      w.varint(features.length);
      const c: Cursor = { u: 0, v: 0 };
      for (const raw of features) {
        const f = raw as TileLayers['pois'][number];
        w.string(f.id);
        w.string(f.name);
        let flags = POI_CATEGORIES.indexOf(f.cat);
        if (f.buildingId !== undefined) flags |= 0x10;
        if (f.snapped) flags |= 0x20;
        w.u8(flags);
        if (f.buildingId !== undefined) w.string(f.buildingId);
        if (f.snapped) w.varint(Math.round((f.snapDistanceMeters ?? 0) * 10));
        writeGeom(w, [[f.u, f.v]], c);
      }
    },
    decode(r) {
      const n = r.varint();
      const out: unknown[] = new Array(n);
      const c: Cursor = { u: 0, v: 0 };
      for (let i = 0; i < n; i++) {
        const f: Record<string, unknown> = { id: r.string(), name: r.string() };
        const flags = r.u8();
        f['cat'] = POI_CATEGORIES[flags & 0x0f];
        if (flags & 0x10) f['buildingId'] = r.string();
        if (flags & 0x20) {
          f['snapped'] = true;
          f['snapDistanceMeters'] = r.varint() / 10;
        }
        const [p] = readGeom(r, c);
        f['u'] = p![0];
        f['v'] = p![1];
        out[i] = f;
      }
      return out;
    },
  },
  stations: {
    encode(w, features) {
      w.varint(features.length);
      const c: Cursor = { u: 0, v: 0 };
      for (const raw of features) {
        const f = raw as TileLayers['stations'][number];
        w.string(f.id);
        w.string(f.name);
        writeGeom(w, [[f.u, f.v]], c);
      }
    },
    decode(r) {
      const n = r.varint();
      const out: unknown[] = new Array(n);
      const c: Cursor = { u: 0, v: 0 };
      for (let i = 0; i < n; i++) {
        const f: Record<string, unknown> = { id: r.string(), name: r.string() };
        const [p] = readGeom(r, c);
        f['u'] = p![0];
        f['v'] = p![1];
        out[i] = f;
      }
      return out;
    },
  },
  districts: {
    encode(w, features) {
      w.varint(features.length);
      const c: Cursor = { u: 0, v: 0 };
      for (const raw of features) {
        const f = raw as TileLayers['districts'][number];
        w.string(f.name);
        w.u8(f.water ? 1 : 0);
        writeGeom(w, [[f.u, f.v]], c);
      }
    },
    decode(r) {
      const n = r.varint();
      const out: unknown[] = new Array(n);
      const c: Cursor = { u: 0, v: 0 };
      for (let i = 0; i < n; i++) {
        const f: Record<string, unknown> = { name: r.string() };
        if (r.u8()) f['water'] = true;
        const [p] = readGeom(r, c);
        f['u'] = p![0];
        f['v'] = p![1];
        out[i] = f;
      }
      return out;
    },
  },
};

/** Arguments to {@link encodeTile}. */
export interface EncodeTileOptions {
  extent: number;
  buffer: number;
  /** Indices into the archive metadata `attribution` table (§4.2). Written on every tile. */
  attribution: readonly number[];
  layers: TileLayers;
}

/** Encodes one tile. Empty layers are omitted entirely. */
export function encodeTile(options: EncodeTileOptions): Buffer {
  const { extent, buffer, attribution, layers } = options;
  const w = new Writer();
  MAGIC.copy(w.buf, 0);
  w.len = 4;
  w.u8(MTIL_VERSION);
  w.u8(FLAG_CLIPPED);
  w.u16(extent);
  w.u16(buffer);
  w.varint(attribution.length);
  for (const i of attribution) w.varint(i);

  const present = LAYER_NAMES.filter((name) => layers[name].length > 0);
  w.varint(present.length);
  for (const name of present) {
    const inner = new Writer();
    codecs[name].encode(inner, layers[name]);
    w.u8(LAYER_ID[name]);
    w.bytes(inner.done());
  }
  return Buffer.from(w.done());
}

/** A decoded tile. */
export interface DecodedTile {
  version: number;
  clipped: boolean;
  extent: number;
  buffer: number;
  attribution: number[];
  layers: TileLayers;
}

/** Decodes a tile produced by {@link encodeTile}. Unknown layer ids are skipped. */
export function decodeTile(buf: Buffer): DecodedTile {
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error('not an MTIL tile');
  const r = new Reader(buf);
  r.pos = 4;
  const version = r.u8();
  if (version !== MTIL_VERSION) throw new Error(`unsupported MTIL version ${version}`);
  const flags = r.u8();
  const extent = r.u16();
  const buffer = r.u16();
  const attrCount = r.varint();
  const attribution: number[] = [];
  for (let i = 0; i < attrCount; i++) attribution.push(r.varint());
  const layers = emptyLayers();
  const layerCount = r.varint();
  for (let i = 0; i < layerCount; i++) {
    const id = r.u8();
    const len = r.varint();
    const body = r.sub(len);
    const name = LAYER_BY_ID[id];
    if (!name) continue; // forward compatibility: skip unknown layers
    (layers[name] as unknown[]) = codecs[name].decode(new Reader(body));
  }
  return { version, clipped: (flags & FLAG_CLIPPED) === FLAG_CLIPPED, extent, buffer, attribution, layers };
}
