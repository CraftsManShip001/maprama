#!/usr/bin/env node
/**
 * Builds a **synthetic** nationwide tile archive for the streaming harnesses.
 *
 *   node --import tsx scripts/make-tile-fixture.mjs [out.pmtiles]
 *
 * Why synthetic: the checks the engine needs are about geometry that crosses
 * tile edges, empty regions and travelling hundreds of kilometres, and none of
 * those need real OpenStreetMap data. A generated archive is deterministic,
 * offline, fast, carries no ODbL obligations into the repository, and can put a
 * river exactly on a tile boundary — which is the case the rendering rule in
 * `design/tile-format.md` §3.2 exists for and which real data gives you only by
 * accident. Real archives are built by `tools/`; this one is a test rig.
 *
 * What it contains (z15 detail + z13 overview, gzip, `tile_type = 0`):
 * - **Seoul** and **Busan** blocks, 325 km apart, so a camera flying between
 *   them crosses the re-base threshold many times.
 * - A **river** running west to east straight through every Seoul tile, clipped
 *   at the tile edges exactly as the real tiler clips it, so the synthetic-edge
 *   rule is exercised.
 * - **Roads** that cross tile edges, to show whether the two halves meet.
 * - **Buildings** on a regular grid, plus a deliberate one straddling the edge
 *   of its tile (anchor-owned, uncut) to show the halo working.
 * - **Holes**: the tiles between the two cities are simply not written, which is
 *   what a real archive does with mountains.
 *
 * The file is written under `.fixtures/` (gitignored). Archives are data, not
 * source: never commit one.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { zxyToTileId } from 'pmtiles';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { encodeTile } = await import(new URL('../../protocol/src/__fixtures__/tile.ts', import.meta.url).href);

const EXTENT = 8192;
const BUFFER = 256;
const DETAIL_Z = 15;
const OVERVIEW_Z = 13;

/** The two cities, and how many detail tiles each gets on a side. */
const REGIONS = [
  { name: 'Seoul', lng: 127.056, lat: 37.5445, tiles: 6, river: true },
  { name: 'Busan', lng: 129.056, lat: 35.1575, tiles: 4, river: false },
];

const ATTRIBUTION = ['© OpenStreetMap contributors', 'Synthetic fixture — not real map data'];

/* ------------------------------------------------------------ mercator */

const lngLatToMercator = (lng, lat) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return { mx: (lng + 180) / 360, my: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI) };
};
const tileOf = (lng, lat, z) => {
  const { mx, my } = lngLatToMercator(lng, lat);
  const n = 2 ** z;
  return { x: Math.floor(mx * n), y: Math.floor(my * n) };
};

/* ------------------------------------------------------------ content */

/** Deterministic PRNG so two runs produce the same archive byte for byte. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Clips a polyline to `[-buffer, extent + buffer]²` (Liang–Barsky per segment). */
function clipLine(pts, lo, hi) {
  const out = [];
  let run = [];
  const inside = (p) => p[0] >= lo && p[0] <= hi && p[1] >= lo && p[1] <= hi;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (inside(a) && inside(b)) {
      if (run.length === 0) run.push(a);
      run.push(b);
      continue;
    }
    const seg = clipSegment(a, b, lo, hi);
    if (!seg) {
      if (run.length >= 2) out.push(run);
      run = [];
      continue;
    }
    if (run.length === 0) run.push(seg[0]);
    run.push(seg[1]);
    if (!inside(b)) {
      out.push(run);
      run = [];
    }
  }
  if (run.length >= 2) out.push(run);
  return out.map((r) => r.map((p) => [Math.round(p[0]), Math.round(p[1])]));
}

function clipSegment(a, b, lo, hi) {
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  for (const [p, q] of [[-dx, a[0] - lo], [dx, hi - a[0]], [-dy, a[1] - lo], [dy, hi - a[1]]]) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return [[a[0] + t0 * dx, a[1] + t0 * dy], [a[0] + t1 * dx, a[1] + t1 * dy]];
}

/** The layers of one detail tile of a region. `gi`/`gj` are the tile's position in the block. */
function detailLayers(region, gi, gj) {
  const r = rng(((gi + 17) * 131 + (gj + 7)) * 2654435761);
  const layers = { roads: [], buildings: [], water: [], parks: [], pois: [], stations: [], districts: [] };
  const lo = -BUFFER, hi = EXTENT + BUFFER;

  // Roads: a grid that runs straight through the tile, so every edge has a road
  // crossing it. Clipped like the real tiler, with `#n` suffixes on the pieces.
  const lines = [];
  for (let k = 1; k <= 3; k++) lines.push({ id: `road-h-${gj}-${k}`, cls: k === 2 ? 'arterial' : 'local', pts: [[lo, (k * EXTENT) / 4], [hi, (k * EXTENT) / 4]] });
  for (let k = 1; k <= 3; k++) lines.push({ id: `road-v-${gi}-${k}`, cls: k === 2 ? 'arterial' : 'local', pts: [[(k * EXTENT) / 4, lo], [(k * EXTENT) / 4, hi]] });
  for (const line of lines) {
    const parts = clipLine(line.pts, lo, hi);
    parts.forEach((pts, i) => {
      layers.roads.push({ id: parts.length > 1 ? `${line.id}#${i}` : line.id, cls: line.cls, name: line.cls === 'arterial' ? 'Main Street' : undefined, pts });
    });
  }

  // Buildings: a grid of boxes, uncut, each owned by whichever tile holds its
  // anchor. One of them deliberately hangs 380 units (~45 m) out of the tile.
  for (let bi = 0; bi < 6; bi++) {
    for (let bj = 0; bj < 6; bj++) {
      const cx = 700 + bi * 1400, cy = 700 + bj * 1400;
      const w = 300 + Math.floor(r() * 360), h = 300 + Math.floor(r() * 360);
      layers.buildings.push({
        id: `b-${gi}-${gj}-${bi}-${bj}`,
        heightDm: 80 + Math.floor(r() * 600),
        levels: 3 + Math.floor(r() * 20),
        kind: ['glass', 'office', 'apartment', 'brick'][Math.floor(r() * 4)],
        footprint: [[cx - w, cy - h], [cx + w, cy - h], [cx + w, cy + h], [cx - w, cy + h]],
      });
    }
  }
  layers.buildings.push({
    id: `b-edge-${gi}-${gj}`,
    heightDm: 420,
    name: 'Edge Tower',
    // Anchor inside the tile, geometry 380 units past the east edge: this is the
    // building that disappears if the renderer culls to exactly the visible tiles.
    footprint: [[EXTENT - 300, 5600], [EXTENT + 380, 5600], [EXTENT + 380, 6000], [EXTENT - 300, 6000]],
  });

  if (region.river) {
    // A river band across the whole tile. Its north and south edges are real
    // banks; its east and west edges sit exactly on the clip rectangle and are
    // pure clipping artefacts — a bank there would be a wall across the river.
    const y0 = 6600, y1 = 7400;
    layers.water.push({ poly: [[lo, y0], [hi, y0], [hi, y1], [lo, y1]] });
    layers.districts.push({ name: 'Test River', u: EXTENT / 2, v: (y0 + y1) / 2, water: true });
  }
  layers.parks.push({ name: `Park ${gi}-${gj}`, poly: [[400, 400], [2200, 400], [2200, 2200], [400, 2200]] });
  layers.pois.push({ id: `poi-${gi}-${gj}`, name: `Cafe ${gi}-${gj}`, cat: 'cafe', u: 700, v: 700, buildingId: `b-${gi}-${gj}-0-0` });
  if (gi === 0 && gj === 0) layers.stations.push({ id: `stn-${region.name}`, name: `${region.name} Station`, u: 4096, v: 4096 });
  if (gi === 0 && gj === 0) layers.districts.push({ name: region.name, u: 4096, v: 3000 });
  return layers;
}

/** The overview level: fewer, bigger buildings and the arterials only. */
function overviewLayers(region, gi, gj) {
  const r = rng(((gi + 3) * 31 + (gj + 11)) * 22695477);
  const layers = { roads: [], buildings: [], districts: [] };
  const lo = -BUFFER, hi = EXTENT + BUFFER;
  layers.roads.push({ id: `ov-h-${gi}-${gj}`, cls: 'arterial', pts: [[lo, EXTENT / 2], [hi, EXTENT / 2]] });
  layers.roads.push({ id: `ov-v-${gi}-${gj}`, cls: 'arterial', pts: [[EXTENT / 2, lo], [EXTENT / 2, hi]] });
  for (let bi = 0; bi < 4; bi++) {
    for (let bj = 0; bj < 4; bj++) {
      const cx = 1000 + bi * 2000, cy = 1000 + bj * 2000;
      const s = 400 + Math.floor(r() * 300);
      layers.buildings.push({ id: `ovb-${gi}-${gj}-${bi}-${bj}`, heightDm: 400 + Math.floor(r() * 1200), footprint: [[cx - s, cy - s], [cx + s, cy - s], [cx + s, cy + s], [cx - s, cy + s]] });
    }
  }
  if (gi === 0 && gj === 0) layers.districts.push({ name: region.name, u: 4096, v: 4096 });
  return layers;
}

/* ------------------------------------------------------------ archive */

const tiles = [];
let west = 180, east = -180, south = 90, north = -90;
for (const region of REGIONS) {
  const base = tileOf(region.lng, region.lat, DETAIL_Z);
  for (let gj = 0; gj < region.tiles; gj++) {
    for (let gi = 0; gi < region.tiles; gi++) {
      tiles.push({ z: DETAIL_Z, x: base.x + gi, y: base.y + gj, bytes: encodeTile({ extent: EXTENT, buffer: BUFFER, attribution: region.river ? [0, 1] : [0], layers: detailLayers(region, gi, gj) }) });
    }
  }
  const ov = tileOf(region.lng, region.lat, OVERVIEW_Z);
  for (let gj = 0; gj < 2; gj++) {
    for (let gi = 0; gi < 2; gi++) {
      tiles.push({ z: OVERVIEW_Z, x: ov.x + gi, y: ov.y + gj, bytes: encodeTile({ extent: EXTENT, buffer: BUFFER, attribution: [0], layers: overviewLayers(region, gi, gj) }) });
    }
  }
  const n = 2 ** DETAIL_Z;
  const w = ((base.x / n) * 360 - 180), e = (((base.x + region.tiles) / n) * 360 - 180);
  west = Math.min(west, w);
  east = Math.max(east, e);
  south = Math.min(south, region.lat - 0.1);
  north = Math.max(north, region.lat + 0.1);
}

/* ---- PMTiles v3 (spec: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md) ---- */

const varint = (n) => {
  const out = [];
  let v = BigInt(n);
  do {
    let byte = Number(v % 128n);
    v /= 128n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return Buffer.from(out);
};

function serializeDirectory(entries) {
  const parts = [varint(entries.length)];
  let last = 0;
  for (const e of entries) {
    parts.push(varint(e.tileId - last));
    last = e.tileId;
  }
  for (const e of entries) parts.push(varint(e.runLength));
  for (const e of entries) parts.push(varint(e.length));
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i], prev = entries[i - 1];
    parts.push(i > 0 && prev.offset + prev.length === e.offset ? varint(0) : varint(e.offset + 1));
  }
  return Buffer.concat(parts);
}

const list = tiles
  .map((t) => ({ ...t, tileId: Number(zxyToTileId(t.z, t.x, t.y)), body: gzipSync(Buffer.from(t.bytes), { level: 9 }) }))
  .sort((a, b) => a.tileId - b.tileId);

const byHash = new Map();
const blobs = [];
const entries = [];
let dataLength = 0;
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
  if (prev && prev.offset === placed.offset && prev.length === placed.length && prev.tileId + prev.runLength === t.tileId) prev.runLength++;
  else entries.push({ tileId: t.tileId, offset: placed.offset, length: placed.length, runLength: 1 });
}

const metadata = {
  format: 'maprama-mtil-1',
  name: 'Maprama streaming fixture',
  extent: EXTENT,
  buffer: BUFFER,
  attribution: ATTRIBUTION,
  layers: ['roads', 'buildings', 'water', 'parks', 'pois', 'stations', 'districts'],
  profiles: { [String(OVERVIEW_Z)]: 'overview', [String(DETAIL_Z)]: 'detail' },
};
const metaBytes = gzipSync(Buffer.from(JSON.stringify(metadata), 'utf8'), { level: 9 });
const rootBytes = gzipSync(serializeDirectory(entries), { level: 9 });

const HEADER_BYTES = 127;
const rootOffset = HEADER_BYTES;
const metadataOffset = rootOffset + rootBytes.length;
const leafOffset = metadataOffset + metaBytes.length;
const header = Buffer.alloc(HEADER_BYTES);
header.write('PMTiles', 0, 'ascii');
header.writeUInt8(3, 7);
const u64 = (v, at) => header.writeBigUInt64LE(BigInt(v), at);
u64(rootOffset, 8);
u64(rootBytes.length, 16);
u64(metadataOffset, 24);
u64(metaBytes.length, 32);
u64(leafOffset, 40);
u64(0, 48);
u64(leafOffset, 56);
u64(dataLength, 64);
u64(list.length, 72);
u64(entries.length, 80);
u64(byHash.size, 88);
header.writeUInt8(1, 96); // clustered
header.writeUInt8(2, 97); // internal compression: gzip
header.writeUInt8(2, 98); // tile compression: gzip
header.writeUInt8(0, 99); // tile type: Unknown (MTIL, not MVT)
header.writeUInt8(OVERVIEW_Z, 100);
header.writeUInt8(DETAIL_Z, 101);
header.writeInt32LE(Math.round(west * 1e7), 102);
header.writeInt32LE(Math.round(south * 1e7), 106);
header.writeInt32LE(Math.round(east * 1e7), 110);
header.writeInt32LE(Math.round(north * 1e7), 114);
header.writeUInt8(DETAIL_Z, 118);
header.writeInt32LE(Math.round(REGIONS[0].lng * 1e7), 119);
header.writeInt32LE(Math.round(REGIONS[0].lat * 1e7), 123);

const out = process.argv[2] ?? join(root, '.fixtures', 'streaming.pmtiles');
mkdirSync(dirname(out), { recursive: true });
const buffer = Buffer.concat([header, rootBytes, metaBytes, ...blobs]);
writeFileSync(out, buffer);
console.log(
  `make-tile-fixture: ${out} — ${list.length} tiles (z${OVERVIEW_Z} + z${DETAIL_Z}), ${entries.length} directory entries, ${(buffer.length / 1024).toFixed(1)} KiB`,
);
