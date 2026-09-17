/**
 * MTIL v1 **writer**, for tests and conformance fixtures.
 *
 * The shipped package only reads tiles (`src/tile.ts`); archives are built by
 * the tile pipeline in `tools/`. This encoder exists so the reader can be
 * tested against bytes produced from a declarative description, and so the same
 * bytes can be handed to the C++ core as a golden fixture. It is deliberately
 * the mirror image of the reader, written from `design/tile-format.md` rather
 * than from the reader's code.
 */

import {
  BUILDING_KINDS,
  MTIL_BUFFER,
  MTIL_EXTENT,
  MTIL_LAYERS,
  POI_CATEGORIES,
  ROAD_CLASSES,
  type MtilLayerName,
  type TileLayers,
  type TileVec2,
} from '../index.js';

class Writer {
  private buf = new Uint8Array(4096);
  len = 0;

  private need(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(v: number): void {
    this.need(1);
    this.buf[this.len++] = v & 0xff;
  }

  u16(v: number): void {
    this.need(2);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
  }

  varint(v: number): void {
    this.need(10);
    let x = v;
    do {
      let byte = x % 128;
      x = Math.floor(x / 128);
      if (x > 0) byte |= 0x80;
      this.buf[this.len++] = byte;
    } while (x > 0);
  }

  svarint(v: number): void {
    this.varint(v < 0 ? -2 * v - 1 : 2 * v);
  }

  string(s: string): void {
    const b = new TextEncoder().encode(s);
    this.varint(b.length);
    this.need(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  bytes(b: Uint8Array): void {
    this.varint(b.length);
    this.need(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  done(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

interface Cursor {
  u: number;
  v: number;
}

function writeGeom(w: Writer, pts: readonly TileVec2[], c: Cursor): void {
  w.varint(pts.length);
  for (const [u, v] of pts) {
    w.svarint(u - c.u);
    w.svarint(v - c.v);
    c.u = u;
    c.v = v;
  }
}

const ENCODERS = {
  roads: (w: Writer, features: NonNullable<TileLayers['roads']>) => {
    w.varint(features.length);
    const c: Cursor = { u: 0, v: 0 };
    for (const f of features) {
      w.string(f.id);
      let flags = ROAD_CLASSES.indexOf(f.cls);
      if (f.name !== undefined) flags |= 0x04;
      if (f.bridge) flags |= 0x08;
      w.u8(flags);
      if (f.name !== undefined) w.string(f.name);
      writeGeom(w, f.pts, c);
    }
  },
  buildings: (w: Writer, features: NonNullable<TileLayers['buildings']>) => {
    w.varint(features.length);
    const c: Cursor = { u: 0, v: 0 };
    for (const f of features) {
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
  water: (w: Writer, features: NonNullable<TileLayers['water']>) => {
    w.varint(features.length);
    const c: Cursor = { u: 0, v: 0 };
    for (const f of features) writeGeom(w, f.poly, c);
  },
  parks: (w: Writer, features: NonNullable<TileLayers['parks']>) => {
    w.varint(features.length);
    const c: Cursor = { u: 0, v: 0 };
    for (const f of features) {
      w.u8(f.name !== undefined ? 1 : 0);
      if (f.name !== undefined) w.string(f.name);
      writeGeom(w, f.poly, c);
    }
  },
  pois: (w: Writer, features: NonNullable<TileLayers['pois']>) => {
    w.varint(features.length);
    const c: Cursor = { u: 0, v: 0 };
    for (const f of features) {
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
  stations: (w: Writer, features: NonNullable<TileLayers['stations']>) => {
    w.varint(features.length);
    const c: Cursor = { u: 0, v: 0 };
    for (const f of features) {
      w.string(f.id);
      w.string(f.name);
      writeGeom(w, [[f.u, f.v]], c);
    }
  },
  districts: (w: Writer, features: NonNullable<TileLayers['districts']>) => {
    w.varint(features.length);
    const c: Cursor = { u: 0, v: 0 };
    for (const f of features) {
      w.string(f.name);
      w.u8(f.water ? 1 : 0);
      writeGeom(w, [[f.u, f.v]], c);
    }
  },
};

export interface EncodeTileOptions {
  extent?: number;
  buffer?: number;
  clipped?: boolean;
  /** Indices into the archive metadata `attribution` table. */
  attribution?: readonly number[];
  layers: TileLayers;
  /** Extra layers with ids this build does not know, to exercise forward compatibility. */
  unknownLayers?: { id: number; bytes: Uint8Array }[];
}

/** Encodes one MTIL v1 tile (uncompressed). Empty layers are omitted entirely. */
export function encodeTile(opts: EncodeTileOptions): Uint8Array {
  const w = new Writer();
  for (const ch of [0x4d, 0x54, 0x49, 0x4c]) w.u8(ch);
  w.u8(1);
  w.u8(opts.clipped === false ? 0 : 0x01);
  w.u16(opts.extent ?? MTIL_EXTENT);
  w.u16(opts.buffer ?? MTIL_BUFFER);
  const attr = opts.attribution ?? [];
  w.varint(attr.length);
  for (const i of attr) w.varint(i);

  const present = (Object.keys(MTIL_LAYERS) as MtilLayerName[]).filter((name) => (opts.layers[name]?.length ?? 0) > 0);
  const extra = opts.unknownLayers ?? [];
  w.varint(present.length + extra.length);
  for (const name of present) {
    const inner = new Writer();
    (ENCODERS[name] as (w: Writer, f: unknown) => void)(inner, opts.layers[name]);
    w.u8(MTIL_LAYERS[name]);
    w.bytes(inner.done());
  }
  for (const e of extra) {
    w.u8(e.id);
    w.bytes(e.bytes);
  }
  return w.done();
}

/**
 * A small tile that exercises every layer, every optional field and both signs
 * of the coordinate range (geometry outside `0..extent`, which anchor-owned
 * buildings and the clip buffer both produce).
 */
export function sampleTileLayers(): TileLayers {
  return {
    roads: [
      { id: 'w101#0', cls: 'arterial', name: '강남대로', pts: [[-256, 4096], [4096, 4096], [8448, 4100]] },
      { id: 'w102', cls: 'alley', bridge: true, pts: [[100, -256], [110, 8448]] },
    ],
    buildings: [
      { id: 'b1', heightDm: 372, levels: 12, kind: 'glass', name: '타워', footprint: [[1000, 1000], [1400, 1000], [1400, 1400], [1000, 1400]] },
      { id: 'b2', heightDm: 45, footprint: [[-390, 8000], [200, 8000], [200, 8300]] },
    ],
    water: [{ poly: [[0, 6000], [8192, 6000], [8192, 6400], [0, 6400]] }],
    parks: [{ name: 'Seoul Forest', poly: [[2000, 2000], [2600, 2000], [2600, 2600]] }, { poly: [[10, 10], [20, 10], [20, 20]] }],
    pois: [
      { id: 'p1', name: 'Cafe', cat: 'cafe', u: 1200, v: 1200, buildingId: 'b1' },
      { id: 'p2', name: 'Store', cat: 'store', u: 3000, v: 200, snapped: true, snapDistanceMeters: 4.2 },
    ],
    stations: [{ id: 's1', name: 'Seongsu', u: 4000, v: 4000 }],
    districts: [{ name: 'Seongsu-dong', u: 4096, v: 4096 }, { name: 'Han River', u: 4096, v: 6200, water: true }],
  };
}
