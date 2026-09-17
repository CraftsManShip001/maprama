/**
 * MTIL v1: the tile payload one streamed world is made of, and the archive
 * metadata contract that goes with it.
 *
 * The format is specified in `design/tile-format.md`; this module is the
 * normative **reader**. Everything here is pure (no fetch, no PMTiles, no
 * gzip): it takes the bytes of one already-decompressed tile and returns
 * features in tile-local integer coordinates. Who fetched those bytes, and how,
 * is the engine's problem.
 *
 * Layout (little-endian, `varint` = unsigned LEB128, `svarint` = zigzag + varint):
 *
 * ```
 * magic    "MTIL"                       4 B
 * version  u8 = 1
 * flags    u8    bit0 = geometry is clipped to the tile + buffer
 * extent   u16   tile-local units per tile edge (8192)
 * buffer   u16   units of geometry kept outside the tile edge (256)
 * attr     varint n, varint × n         indices into the archive metadata string table
 * layers   varint n, layer × n
 * layer    u8 id, varint byteLength, bytes
 * ```
 *
 * A layer carries its `byteLength`, so a reader that does not know a layer id
 * skips it: new layers do not break old clients.
 *
 * Geometry is a cursor stream (MVT-style): every vertex is a zigzag-varint
 * delta from the previous one, and a feature's first vertex is a delta from the
 * previous feature's last vertex. One cursor per layer, starting at `(0, 0)`.
 * Coordinates may be negative or exceed `extent` by up to `buffer` (clipped
 * layers) or by much more (anchor-owned layers, which are never cut).
 *
 * @module
 */

import {
  BUILDING_KINDS,
  POI_CATEGORIES,
  ROAD_CLASSES,
  type BuildingKind,
  type PoiCategory,
  type RoadClass,
} from './world.js';
import { array, integer, nonEmptyString, object, positiveNumber, record, run, string, type Check, type ValidationResult } from './internal/validate.js';

/** Current MTIL tile payload version. */
export const MTIL_VERSION = 1;

/** `format` string every Maprama tile archive's metadata must carry. */
export const MTIL_FORMAT = 'maprama-mtil-1';

/** The four magic bytes every MTIL tile starts with (`"MTIL"`). */
export const MTIL_MAGIC = 0x4c49544d; // 'M' | 'T'<<8 | 'I'<<16 | 'L'<<24

/** Tile-local units per tile edge used by the built archives. */
export const MTIL_EXTENT = 8192;

/** Units of geometry kept outside the tile edge for clipped layers (30 m at z15). */
export const MTIL_BUFFER = 256;

/** Layer ids, fixed by the format. */
export const MTIL_LAYERS = {
  roads: 1,
  buildings: 2,
  water: 3,
  parks: 4,
  pois: 5,
  stations: 6,
  districts: 7,
} as const;

/** Name of an MTIL layer. */
export type MtilLayerName = keyof typeof MTIL_LAYERS;

/** Layer names in id order. */
export const MTIL_LAYER_NAMES = Object.keys(MTIL_LAYERS) as MtilLayerName[];

/**
 * How a layer's geometry crosses a tile edge.
 *
 * - `anchor`: the tile containing the feature's anchor point owns the **whole**
 *   feature, uncut. Buildings, POIs, stations and districts — a building is the
 *   most visible thing in a 2.5D map, and half a building is worse than a
 *   building that pokes out of its tile. The renderer must load a ring of tiles
 *   beyond the visible ones or edge buildings go missing.
 * - `clip`: the feature is cut to the tile plus {@link MTIL_BUFFER}. Roads,
 *   water and parks — a single river or motorway would otherwise be stored in
 *   thousands of tiles. Cut edges land exactly on the tile boundary, so two
 *   loaded neighbours join seamlessly.
 */
export const MTIL_LAYER_OWNERSHIP: Readonly<Record<MtilLayerName, 'anchor' | 'clip'>> = Object.freeze({
  roads: 'clip',
  buildings: 'anchor',
  water: 'clip',
  parks: 'clip',
  pois: 'anchor',
  stations: 'anchor',
  districts: 'anchor',
});

/** A tile-local integer vertex `[u, v]`: `u` east, `v` **south** (Web Mercator, y grows south). */
export type TileVec2 = [number, number];

/** A road in tile-local coordinates. Clipped pieces keep the source id with a `#n` suffix. */
export interface TileRoad {
  id: string;
  name?: string;
  cls: RoadClass;
  bridge?: boolean;
  pts: TileVec2[];
}

/** A building in tile-local coordinates. Height is **decimetres**, not world units. */
export interface TileBuilding {
  id: string;
  /** Height in decimetres (integer). */
  heightDm: number;
  levels?: number;
  kind?: BuildingKind;
  name?: string;
  footprint: TileVec2[];
}

/** A water polygon in tile-local coordinates. */
export interface TileWater {
  poly: TileVec2[];
}

/** A park in tile-local coordinates. */
export interface TilePark {
  name?: string;
  poly: TileVec2[];
}

/** A POI in tile-local coordinates. `buildingId` may name a building in another tile. */
export interface TilePoi {
  id: string;
  name: string;
  cat: PoiCategory;
  u: number;
  v: number;
  buildingId?: string;
  snapped?: boolean;
  snapDistanceMeters?: number;
}

/** A station in tile-local coordinates. */
export interface TileStation {
  id: string;
  name: string;
  u: number;
  v: number;
}

/** A district label anchor in tile-local coordinates. */
export interface TileDistrict {
  name: string;
  water?: boolean;
  u: number;
  v: number;
}

/** The layers of one decoded tile. A layer that the tile does not carry is absent. */
export interface TileLayers {
  roads?: TileRoad[];
  buildings?: TileBuilding[];
  water?: TileWater[];
  parks?: TilePark[];
  pois?: TilePoi[];
  stations?: TileStation[];
  districts?: TileDistrict[];
}

/** One decoded MTIL tile. */
export interface MtilTile {
  version: number;
  /** True when clipped layers were cut to the tile plus {@link buffer}. */
  clipped: boolean;
  extent: number;
  buffer: number;
  /** Indices into the archive metadata's `attribution` string table. */
  attribution: number[];
  layers: TileLayers;
  /** Layer ids present in the payload that this reader does not know (forward compatibility). */
  unknownLayers: number[];
}

/** Thrown by {@link decodeTile} when the bytes are not a tile this reader can read. */
export class TileDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TileDecodeError';
  }
}

/* -------------------------------------------------------------------- reader */

class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array, readonly end: number = buf.length) {}

  private need(n: number): void {
    if (this.pos + n > this.end) throw new TileDecodeError(`truncated tile: wanted ${n} byte(s) at ${this.pos}, have ${this.end - this.pos}`);
  }

  u8(): number {
    this.need(1);
    return this.buf[this.pos++]!;
  }

  u16(): number {
    this.need(2);
    const v = this.buf[this.pos]! | (this.buf[this.pos + 1]! << 8);
    this.pos += 2;
    return v;
  }

  /**
   * Unsigned LEB128. Accumulated with multiplication rather than `<<` so values
   * above 2^31 still decode (a string length or a coordinate never gets there,
   * but a corrupt byte stream can claim one, and silently wrapping to a
   * negative number would turn that into an out-of-bounds read).
   */
  varint(): number {
    let result = 0;
    let shift = 1;
    let byte: number;
    let bytes = 0;
    do {
      this.need(1);
      byte = this.buf[this.pos++]!;
      result += (byte & 0x7f) * shift;
      shift *= 128;
      if (++bytes > 10) throw new TileDecodeError(`varint at ${this.pos} is longer than 10 bytes`);
    } while (byte & 0x80);
    if (!Number.isSafeInteger(result)) throw new TileDecodeError(`varint at ${this.pos} is out of range`);
    return result;
  }

  svarint(): number {
    const v = this.varint();
    return v & 1 ? -(v + 1) / 2 : v / 2;
  }

  string(): string {
    const n = this.varint();
    this.need(n);
    const s = utf8(this.buf, this.pos, this.pos + n);
    this.pos += n;
    return s;
  }

  /** A sub-reader over the next `n` bytes; advances this reader past them. */
  sub(n: number): Reader {
    this.need(n);
    const r = new Reader(this.buf, this.pos + n);
    r.pos = this.pos;
    this.pos += n;
    return r;
  }
}

/**
 * Minimal structural view of the platform's `TextDecoder`. The package is built
 * without the DOM and Node type libraries (it has to compile for every host), so
 * the one global it wants is described here rather than pulled in wholesale.
 */
interface TextDecoderLike {
  decode(input: Uint8Array): string;
}

const textDecoderCtor = (globalThis as { TextDecoder?: new (label: string) => TextDecoderLike }).TextDecoder;
const textDecoder: TextDecoderLike | null = textDecoderCtor ? new textDecoderCtor('utf-8') : null;

function utf8(buf: Uint8Array, start: number, end: number): string {
  if (textDecoder) return textDecoder.decode(buf.subarray(start, end));
  // Minimal fallback for environments without TextDecoder (kept so the decoder
  // has no hard platform requirement); correct for the BMP and surrogate pairs.
  let out = '';
  for (let i = start; i < end; ) {
    const b0 = buf[i++]!;
    let cp: number;
    if (b0 < 0x80) cp = b0;
    else if (b0 < 0xe0) cp = ((b0 & 0x1f) << 6) | (buf[i++]! & 0x3f);
    else if (b0 < 0xf0) cp = ((b0 & 0x0f) << 12) | ((buf[i++]! & 0x3f) << 6) | (buf[i++]! & 0x3f);
    else cp = ((b0 & 0x07) << 18) | ((buf[i++]! & 0x3f) << 12) | ((buf[i++]! & 0x3f) << 6) | (buf[i++]! & 0x3f);
    out += String.fromCodePoint(cp);
  }
  return out;
}

interface Cursor {
  u: number;
  v: number;
}

function readGeom(r: Reader, c: Cursor): TileVec2[] {
  const n = r.varint();
  const pts: TileVec2[] = new Array(n);
  for (let i = 0; i < n; i++) {
    c.u += r.svarint();
    c.v += r.svarint();
    pts[i] = [c.u, c.v];
  }
  return pts;
}

function readPoint(r: Reader, c: Cursor): TileVec2 {
  const pts = readGeom(r, c);
  const p = pts[0];
  if (!p) throw new TileDecodeError('point feature has no vertex');
  return p;
}

function decodeRoads(r: Reader): TileRoad[] {
  const n = r.varint();
  const out: TileRoad[] = new Array(n);
  const c: Cursor = { u: 0, v: 0 };
  for (let i = 0; i < n; i++) {
    const id = r.string();
    const flags = r.u8();
    const cls = ROAD_CLASSES[flags & 0x03];
    if (!cls) throw new TileDecodeError(`unknown road class ${flags & 0x03}`);
    const f: TileRoad = { id, cls, pts: [] };
    if (flags & 0x04) f.name = r.string();
    if (flags & 0x08) f.bridge = true;
    f.pts = readGeom(r, c);
    out[i] = f;
  }
  return out;
}

function decodeBuildings(r: Reader): TileBuilding[] {
  const n = r.varint();
  const out: TileBuilding[] = new Array(n);
  const c: Cursor = { u: 0, v: 0 };
  for (let i = 0; i < n; i++) {
    const id = r.string();
    const flags = r.u8();
    const f: TileBuilding = { id, heightDm: r.varint(), footprint: [] };
    if (flags & 0x02) f.levels = r.varint();
    if (flags & 0x04) {
      const k = r.u8();
      const kind = BUILDING_KINDS[k];
      if (!kind) throw new TileDecodeError(`unknown building kind ${k}`);
      f.kind = kind;
    }
    if (flags & 0x01) f.name = r.string();
    f.footprint = readGeom(r, c);
    out[i] = f;
  }
  return out;
}

function decodeWater(r: Reader): TileWater[] {
  const n = r.varint();
  const out: TileWater[] = new Array(n);
  const c: Cursor = { u: 0, v: 0 };
  for (let i = 0; i < n; i++) out[i] = { poly: readGeom(r, c) };
  return out;
}

function decodeParks(r: Reader): TilePark[] {
  const n = r.varint();
  const out: TilePark[] = new Array(n);
  const c: Cursor = { u: 0, v: 0 };
  for (let i = 0; i < n; i++) {
    const f: TilePark = { poly: [] };
    if (r.u8()) f.name = r.string();
    f.poly = readGeom(r, c);
    out[i] = f;
  }
  return out;
}

function decodePois(r: Reader): TilePoi[] {
  const n = r.varint();
  const out: TilePoi[] = new Array(n);
  const c: Cursor = { u: 0, v: 0 };
  for (let i = 0; i < n; i++) {
    const id = r.string();
    const name = r.string();
    const flags = r.u8();
    const cat = POI_CATEGORIES[flags & 0x0f];
    if (!cat) throw new TileDecodeError(`unknown POI category ${flags & 0x0f}`);
    const f: TilePoi = { id, name, cat, u: 0, v: 0 };
    if (flags & 0x10) f.buildingId = r.string();
    if (flags & 0x20) {
      f.snapped = true;
      f.snapDistanceMeters = r.varint() / 10;
    }
    const [u, v] = readPoint(r, c);
    f.u = u;
    f.v = v;
    out[i] = f;
  }
  return out;
}

function decodeStations(r: Reader): TileStation[] {
  const n = r.varint();
  const out: TileStation[] = new Array(n);
  const c: Cursor = { u: 0, v: 0 };
  for (let i = 0; i < n; i++) {
    const f: TileStation = { id: r.string(), name: r.string(), u: 0, v: 0 };
    const [u, v] = readPoint(r, c);
    f.u = u;
    f.v = v;
    out[i] = f;
  }
  return out;
}

function decodeDistricts(r: Reader): TileDistrict[] {
  const n = r.varint();
  const out: TileDistrict[] = new Array(n);
  const c: Cursor = { u: 0, v: 0 };
  for (let i = 0; i < n; i++) {
    const f: TileDistrict = { name: r.string(), u: 0, v: 0 };
    if (r.u8()) f.water = true;
    const [u, v] = readPoint(r, c);
    f.u = u;
    f.v = v;
    out[i] = f;
  }
  return out;
}

const DECODERS: Record<number, (r: Reader, into: TileLayers) => void> = {
  [MTIL_LAYERS.roads]: (r, into) => { into.roads = decodeRoads(r); },
  [MTIL_LAYERS.buildings]: (r, into) => { into.buildings = decodeBuildings(r); },
  [MTIL_LAYERS.water]: (r, into) => { into.water = decodeWater(r); },
  [MTIL_LAYERS.parks]: (r, into) => { into.parks = decodeParks(r); },
  [MTIL_LAYERS.pois]: (r, into) => { into.pois = decodePois(r); },
  [MTIL_LAYERS.stations]: (r, into) => { into.stations = decodeStations(r); },
  [MTIL_LAYERS.districts]: (r, into) => { into.districts = decodeDistricts(r); },
};

/**
 * Decodes one **uncompressed** MTIL v1 tile.
 *
 * @throws TileDecodeError when the magic, the version or the byte stream is wrong.
 */
export function decodeTile(bytes: Uint8Array): MtilTile {
  if (bytes.length < 10) throw new TileDecodeError(`tile is ${bytes.length} byte(s), too short to be MTIL`);
  if (bytes[0] !== 0x4d || bytes[1] !== 0x54 || bytes[2] !== 0x49 || bytes[3] !== 0x4c) {
    throw new TileDecodeError('not an MTIL tile (bad magic)');
  }
  const r = new Reader(bytes);
  r.pos = 4;
  const version = r.u8();
  if (version !== MTIL_VERSION) throw new TileDecodeError(`unsupported MTIL version ${version}`);
  const flags = r.u8();
  const extent = r.u16();
  if (extent <= 0) throw new TileDecodeError(`invalid extent ${extent}`);
  const buffer = r.u16();
  const attrCount = r.varint();
  const attribution: number[] = new Array(attrCount);
  for (let i = 0; i < attrCount; i++) attribution[i] = r.varint();
  const layers: TileLayers = {};
  const unknownLayers: number[] = [];
  const layerCount = r.varint();
  for (let i = 0; i < layerCount; i++) {
    const id = r.u8();
    const len = r.varint();
    const body = r.sub(len);
    const decode = DECODERS[id];
    // Forward compatibility: `byteLength` already moved the cursor past a layer
    // this build does not know, so a newer archive still renders what it can.
    if (!decode) {
      unknownLayers.push(id);
      continue;
    }
    decode(body, layers);
  }
  return { version, clipped: (flags & 1) === 1, extent, buffer, attribution, layers, unknownLayers };
}

/* ------------------------------------------------------------------ metadata */

/**
 * The JSON metadata a Maprama tile archive carries (PMTiles `metadata`).
 *
 * The client reads this before any tile, which is why every tile can refer to
 * `attribution` by index instead of carrying the strings.
 */
export interface TileArchiveMetadata {
  /** Must be {@link MTIL_FORMAT}; a client rejects anything else. */
  format: string;
  name?: string;
  extent?: number;
  buffer?: number;
  /** Attribution lines the map must display. Tiles index into this table. */
  attribution?: string[];
  layers?: string[];
  /** Zoom level → profile name, e.g. `{ "13": "overview", "15": "detail" }`. */
  profiles?: Record<string, string>;
}

/** @internal */
export const checkTileArchiveMetadata: Check = object(
  { format: nonEmptyString },
  {
    name: string,
    extent: positiveNumber,
    buffer: integer,
    attribution: array(string),
    layers: array(string),
    profiles: record(string),
  },
);

/**
 * Validates a tile archive's parsed metadata JSON. Structure only; it does not
 * check that `format` is {@link MTIL_FORMAT} (the engine reports that as its
 * own error, with the value it found). Never throws.
 */
export function validateTileArchiveMetadata(value: unknown): ValidationResult {
  return run(checkTileArchiveMetadata, value);
}

/**
 * Resolves a tile's attribution indices against the archive string table.
 * Indices that are out of range are dropped: an attribution line that does not
 * exist is not worth failing a map over, and the lines that do exist are still
 * shown.
 */
export function resolveTileAttribution(indices: readonly number[], table: readonly string[] | undefined): string[] {
  if (!table || table.length === 0) return [];
  const out: string[] = [];
  for (const i of indices) {
    const s = table[i];
    if (typeof s === 'string' && s.length > 0 && !out.includes(s)) out.push(s);
  }
  return out;
}
