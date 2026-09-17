/**
 * `MTIL` v1 tile payload: the bytes one PMTiles tile holds.
 *
 * Layout (little-endian, varint = LEB128 unsigned, svarint = zigzag + varint):
 *
 *   magic      "MTIL"                        4 B
 *   version    u8 = 1
 *   flags      u8   bit0 = geometry is clipped to the tile + buffer
 *   extent     u16  tile-local units per tile edge (e.g. 8192)
 *   buffer     u16  units of geometry kept outside the tile edge
 *   attr       varint n, then n × varint     indices into the archive metadata
 *                                            `attribution` string table
 *   layers     varint n, then n × layer
 *   layer      u8 id, varint byteLength, bytes
 *
 * `byteLength` on every layer is what makes the format forward-compatible: a
 * reader that does not know a layer id skips it.
 *
 * Geometry is a cursor stream (MVT-style): each vertex is a zigzag-varint delta
 * from the previous vertex, and a feature's first vertex is a delta from the
 * previous feature's last vertex. Coordinates are tile-local integers; they may
 * be negative or exceed `extent` by up to `buffer`.
 */

export const LAYER = {
  roads: 1,
  buildings: 2,
  water: 3,
  parks: 4,
  pois: 5,
  stations: 6,
  districts: 7,
};
export const LAYER_NAME = Object.fromEntries(Object.entries(LAYER).map(([k, v]) => [v, k]));

const ROAD_CLASSES = ['arterial', 'local', 'alley'];
const BUILDING_KINDS = ['glass', 'office', 'apartment', 'brick'];
const POI_CATEGORIES = ['subway', 'cafe', 'store', 'music', 'school', 'book', 'plaza', 'park'];

/* ------------------------------------------------------------------ writer */

class Writer {
  constructor() {
    this.buf = Buffer.alloc(1 << 16);
    this.len = 0;
  }
  #need(n) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = Buffer.alloc(size);
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }
  u8(v) { this.#need(1); this.buf[this.len++] = v & 0xff; }
  u16(v) { this.#need(2); this.buf.writeUInt16LE(v, this.len); this.len += 2; }
  varint(v) {
    this.#need(10);
    let n = v >>> 0;
    if (v > 0xffffffff) n = v; // fall through to the slow path below
    let x = v;
    do {
      let byte = x & 0x7f;
      x = Math.floor(x / 128);
      if (x > 0) byte |= 0x80;
      this.buf[this.len++] = byte;
    } while (x > 0);
  }
  svarint(v) { this.varint(v < 0 ? -2 * v - 1 : 2 * v); }
  string(s) {
    const b = Buffer.from(s, 'utf8');
    this.varint(b.length);
    this.#need(b.length);
    b.copy(this.buf, this.len);
    this.len += b.length;
  }
  bytes(b) { this.varint(b.length); this.#need(b.length); b.copy(this.buf, this.len); this.len += b.length; }
  done() { return this.buf.subarray(0, this.len); }
}

class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  u8() { return this.buf[this.pos++]; }
  u16() { const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
  varint() {
    let result = 0, shift = 1, byte;
    do {
      byte = this.buf[this.pos++];
      result += (byte & 0x7f) * shift;
      shift *= 128;
    } while (byte & 0x80);
    return result;
  }
  svarint() { const v = this.varint(); return v & 1 ? -(v + 1) / 2 : v / 2; }
  string() { const n = this.varint(); const s = this.buf.toString('utf8', this.pos, this.pos + n); this.pos += n; return s; }
  sub(n) { const b = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return b; }
}

/** Cursor-delta geometry writer shared by every layer. */
function writeGeom(w, pts, cursor) {
  w.varint(pts.length);
  for (const [u, v] of pts) {
    w.svarint(u - cursor.u);
    w.svarint(v - cursor.v);
    cursor.u = u;
    cursor.v = v;
  }
}
function readGeom(r, cursor) {
  const n = r.varint();
  const pts = new Array(n);
  for (let i = 0; i < n; i++) {
    cursor.u += r.svarint();
    cursor.v += r.svarint();
    pts[i] = [cursor.u, cursor.v];
  }
  return pts;
}

/* ---------------------------------------------------------------- layers */

const layerCodecs = {
  [LAYER.roads]: {
    encode(w, features) {
      w.varint(features.length);
      const cursor = { u: 0, v: 0 };
      for (const f of features) {
        w.string(f.id);
        let flags = ROAD_CLASSES.indexOf(f.cls);
        if (f.name !== undefined) flags |= 0x04;
        if (f.bridge) flags |= 0x08;
        w.u8(flags);
        if (f.name !== undefined) w.string(f.name);
        writeGeom(w, f.pts, cursor);
      }
    },
    decode(r) {
      const n = r.varint();
      const out = new Array(n);
      const cursor = { u: 0, v: 0 };
      for (let i = 0; i < n; i++) {
        const id = r.string();
        const flags = r.u8();
        const f = { id, cls: ROAD_CLASSES[flags & 0x03] };
        if (flags & 0x04) f.name = r.string();
        if (flags & 0x08) f.bridge = true;
        f.pts = readGeom(r, cursor);
        out[i] = f;
      }
      return out;
    },
  },
  [LAYER.buildings]: {
    encode(w, features) {
      w.varint(features.length);
      const cursor = { u: 0, v: 0 };
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
        writeGeom(w, f.footprint, cursor);
      }
    },
    decode(r) {
      const n = r.varint();
      const out = new Array(n);
      const cursor = { u: 0, v: 0 };
      for (let i = 0; i < n; i++) {
        const id = r.string();
        const flags = r.u8();
        const f = { id, heightDm: r.varint() };
        if (flags & 0x02) f.levels = r.varint();
        if (flags & 0x04) f.kind = BUILDING_KINDS[r.u8()];
        if (flags & 0x01) f.name = r.string();
        f.footprint = readGeom(r, cursor);
        out[i] = f;
      }
      return out;
    },
  },
  [LAYER.water]: {
    encode(w, features) {
      w.varint(features.length);
      const cursor = { u: 0, v: 0 };
      for (const f of features) writeGeom(w, f.poly, cursor);
    },
    decode(r) {
      const n = r.varint();
      const out = new Array(n);
      const cursor = { u: 0, v: 0 };
      for (let i = 0; i < n; i++) out[i] = { poly: readGeom(r, cursor) };
      return out;
    },
  },
  [LAYER.parks]: {
    encode(w, features) {
      w.varint(features.length);
      const cursor = { u: 0, v: 0 };
      for (const f of features) {
        w.u8(f.name !== undefined ? 1 : 0);
        if (f.name !== undefined) w.string(f.name);
        writeGeom(w, f.poly, cursor);
      }
    },
    decode(r) {
      const n = r.varint();
      const out = new Array(n);
      const cursor = { u: 0, v: 0 };
      for (let i = 0; i < n; i++) {
        const f = {};
        if (r.u8()) f.name = r.string();
        f.poly = readGeom(r, cursor);
        out[i] = f;
      }
      return out;
    },
  },
  [LAYER.pois]: {
    encode(w, features) {
      w.varint(features.length);
      const cursor = { u: 0, v: 0 };
      for (const f of features) {
        w.string(f.id);
        w.string(f.name);
        let flags = POI_CATEGORIES.indexOf(f.cat);
        if (f.buildingId !== undefined) flags |= 0x10;
        if (f.snapped) flags |= 0x20;
        w.u8(flags);
        if (f.buildingId !== undefined) w.string(f.buildingId);
        if (f.snapped) w.varint(Math.round((f.snapDistanceMeters ?? 0) * 10));
        writeGeom(w, [[f.u, f.v]], cursor);
      }
    },
    decode(r) {
      const n = r.varint();
      const out = new Array(n);
      const cursor = { u: 0, v: 0 };
      for (let i = 0; i < n; i++) {
        const f = { id: r.string(), name: r.string() };
        const flags = r.u8();
        f.cat = POI_CATEGORIES[flags & 0x0f];
        if (flags & 0x10) f.buildingId = r.string();
        if (flags & 0x20) { f.snapped = true; f.snapDistanceMeters = r.varint() / 10; }
        const [[u, v]] = readGeom(r, cursor);
        f.u = u; f.v = v;
        out[i] = f;
      }
      return out;
    },
  },
  [LAYER.stations]: {
    encode(w, features) {
      w.varint(features.length);
      const cursor = { u: 0, v: 0 };
      for (const f of features) { w.string(f.id); w.string(f.name); writeGeom(w, [[f.u, f.v]], cursor); }
    },
    decode(r) {
      const n = r.varint();
      const out = new Array(n);
      const cursor = { u: 0, v: 0 };
      for (let i = 0; i < n; i++) {
        const f = { id: r.string(), name: r.string() };
        const [[u, v]] = readGeom(r, cursor);
        f.u = u; f.v = v;
        out[i] = f;
      }
      return out;
    },
  },
  [LAYER.districts]: {
    encode(w, features) {
      w.varint(features.length);
      const cursor = { u: 0, v: 0 };
      for (const f of features) { w.string(f.name); w.u8(f.water ? 1 : 0); writeGeom(w, [[f.u, f.v]], cursor); }
    },
    decode(r) {
      const n = r.varint();
      const out = new Array(n);
      const cursor = { u: 0, v: 0 };
      for (let i = 0; i < n; i++) {
        const f = { name: r.string() };
        if (r.u8()) f.water = true;
        const [[u, v]] = readGeom(r, cursor);
        f.u = u; f.v = v;
        out[i] = f;
      }
      return out;
    },
  },
};

export const MAGIC = Buffer.from('MTIL', 'ascii');

/**
 * Encodes one tile. `layers` is `{ roads: [...], buildings: [...], ... }` with
 * tile-local integer geometry; empty layers are omitted entirely.
 */
export function encodeTile({ extent, buffer, attribution, layers }) {
  const w = new Writer();
  MAGIC.copy(w.buf, 0); w.len = 4;
  w.u8(1);
  w.u8(0x01); // clipped
  w.u16(extent);
  w.u16(buffer);
  w.varint(attribution.length);
  for (const i of attribution) w.varint(i);

  const present = Object.entries(LAYER).filter(([name]) => (layers[name] ?? []).length > 0);
  w.varint(present.length);
  for (const [name, id] of present) {
    const inner = new Writer();
    layerCodecs[id].encode(inner, layers[name]);
    w.u8(id);
    w.bytes(inner.done());
  }
  return Buffer.from(w.done());
}

/** Decodes a tile produced by {@link encodeTile}. Unknown layer ids are skipped. */
export function decodeTile(buf) {
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error('not an MTIL tile');
  const r = new Reader(buf);
  r.pos = 4;
  const version = r.u8();
  if (version !== 1) throw new Error(`unsupported MTIL version ${version}`);
  const flags = r.u8();
  const extent = r.u16();
  const buffer = r.u16();
  const attrCount = r.varint();
  const attribution = [];
  for (let i = 0; i < attrCount; i++) attribution.push(r.varint());
  const layers = {};
  const layerCount = r.varint();
  for (let i = 0; i < layerCount; i++) {
    const id = r.u8();
    const len = r.varint();
    const body = r.sub(len);
    const codec = layerCodecs[id];
    if (!codec) continue; // forward compatibility: skip unknown layers
    layers[LAYER_NAME[id]] = codec.decode(new Reader(body));
  }
  return { version, clipped: (flags & 1) === 1, extent, buffer, attribution, layers };
}
