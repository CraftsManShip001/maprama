/**
 * Spike driver: WorldData -> tiles -> one PMTiles archive, read back with the
 * official `pmtiles` reader, with every number the design document quotes.
 *
 *   node src/cli.mjs build   [--zoom 15] [--extent 8192] [--buffer 256] [--out out/]
 *   node src/cli.mjs measure                  # density + tile-size table over every sample
 *   node src/cli.mjs verify   out/seongsu.pmtiles
 *   node src/cli.mjs extrapolate              # South Korea totals from `measure`
 *
 * Inputs are `tools/osm/samples/seongsu.world.json` plus anything in
 * `tools/tile-spike/.data/*.world.json` (fetched by scripts/fetch-areas.sh,
 * gitignored — OSM data is ODbL, not ours to commit).
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { PMTiles, TileType } from 'pmtiles';

import { tileGroundAreaKm2, tileGroundMeters, tileUnitMeters, fromTileLocal } from './mercator.mjs';
import { worldToGeo, tileFeatures, encodeTiles, filterForOverview } from './tiler.mjs';
import { decodeTile } from './payload.mjs';
import { writePMTiles, TileType as WriteTileType, Compression as WriteCompression } from './pmtiles-write.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const REPO = join(ROOT, '..', '..');
const OUT = join(ROOT, '.out');
const DATA = join(ROOT, '.data');

const DEFAULTS = { zoom: 15, extent: 8192, buffer: 256 };

/** Every world document the spike can measure. */
function samples() {
  const list = [{ name: 'seongsu', path: join(REPO, 'tools', 'osm', 'samples', 'seongsu.world.json') }];
  if (existsSync(DATA)) {
    for (const f of readdirSync(DATA).filter((f) => f.endsWith('.world.json')).sort()) {
      list.push({ name: basename(f, '.world.json'), path: join(DATA, f) });
    }
  }
  return list.filter((s) => existsSync(s.path));
}

const readWorld = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** Ground area of a world document, km², from its bounds. */
function worldAreaKm2(world) {
  const w = (world.bounds.maxX - world.bounds.minX) * world.unitMeters;
  const h = (world.bounds.maxZ - world.bounds.minZ) * world.unitMeters;
  return (w * h) / 1e6;
}

function featureCount(world) {
  return world.roads.length + world.buildings.length + world.water.length + world.parks.length +
    world.pois.length + world.stations.length + world.districts.length;
}

/** Tiles one world at one zoom and returns encoded tiles plus timings. */
function tileWorld(world, opts) {
  const t0 = performance.now();
  const geo = opts.profile === 'overview' ? filterForOverview(worldToGeo(world)) : worldToGeo(world);
  const t1 = performance.now();
  const { tiles, stats } = tileFeatures(geo, opts.zoom, opts);
  const t2 = performance.now();
  const encoded = encodeTiles(tiles, { ...opts, attribution: world.attribution.map((_, i) => i) });
  const t3 = performance.now();
  return {
    geo,
    tiles: encoded,
    stats,
    ms: { project: t1 - t0, split: t2 - t1, encode: t3 - t2, total: t3 - t0 },
  };
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const fmtKB = (b) => (b / 1024).toFixed(1);

/* ------------------------------------------------------------ commands */

async function cmdBuild(opts) {
  mkdirSync(OUT, { recursive: true });
  const sample = samples()[0];
  const world = readWorld(sample.path);
  const r = tileWorld(world, opts);

  const bodies = [...r.tiles.values()].map((t) => ({ z: t.z, x: t.x, y: t.y, bytes: t.bytes }));
  const lats = bodies.map((t) => t.y);
  const b = world.bounds;
  const { origin, unitMeters } = world;
  const west = origin.lng + (b.minX * unitMeters) / (111320 * Math.cos((origin.lat * Math.PI) / 180));
  const east = origin.lng + (b.maxX * unitMeters) / (111320 * Math.cos((origin.lat * Math.PI) / 180));
  const north = origin.lat - (b.minZ * unitMeters) / 110540;
  const south = origin.lat - (b.maxZ * unitMeters) / 110540;

  const t0 = performance.now();
  const archive = writePMTiles(bodies, {
    metadata: {
      format: 'maprama-mtil-1',
      name: world.name,
      extent: opts.extent,
      buffer: opts.buffer,
      attribution: world.attribution,
      layers: ['roads', 'buildings', 'water', 'parks', 'pois', 'stations', 'districts'],
    },
    bounds: { west, south, east, north },
    center: { lng: (west + east) / 2, lat: (south + north) / 2, z: opts.zoom },
    tileType: WriteTileType.Unknown,
    tileCompression: WriteCompression.Gzip,
  });
  const writeMs = performance.now() - t0;

  const file = join(OUT, `${sample.name}.z${opts.zoom}.pmtiles`);
  writeFileSync(file, archive.buffer);

  const sizes = bodies.map((t) => t.bytes.length);
  const gz = bodies.map((t) => gzipSync(t.bytes, { level: 9 }).length);
  console.log(JSON.stringify({
    source: sample.path,
    zoom: opts.zoom,
    extent: opts.extent,
    buffer: opts.buffer,
    tiles: bodies.length,
    tileBytesRaw: { total: sum(sizes), mean: Math.round(sum(sizes) / sizes.length), max: Math.max(...sizes) },
    tileBytesGzip: { total: sum(gz), mean: Math.round(sum(gz) / gz.length), max: Math.max(...gz) },
    archiveBytes: archive.buffer.length,
    archive: archive.stats,
    splitStats: r.stats,
    ms: { ...r.ms, pmtiles: writeMs },
    file,
  }, null, 2));
  return file;
}

/**
 * Serves one file over HTTP with byte-range support, counting what is actually
 * transferred. This is how `verify` proves the range path end to end instead of
 * reading the archive off disk.
 */
async function serveWithRanges(file) {
  const { createServer } = await import('node:http');
  const body = readFileSync(file);
  const counters = { requests: 0, bytes: 0 };
  const server = createServer((req, res) => {
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    counters.requests++;
    if (!m) {
      counters.bytes += body.length;
      res.writeHead(200, { 'Content-Length': String(body.length), 'Accept-Ranges': 'bytes' });
      res.end(body);
      return;
    }
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), body.length - 1);
    const slice = body.subarray(start, end + 1);
    counters.bytes += slice.length;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${body.length}`,
      'Content-Length': String(slice.length),
      'Accept-Ranges': 'bytes',
    });
    res.end(slice);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/archive.pmtiles`, counters, close: () => server.close(), fileBytes: body.length };
}

/** Reads the archive back with the official reader and rebuilds features. */
async function cmdVerify(file, opts) {
  const serving = await serveWithRanges(file);
  const p = new PMTiles(serving.url);
  const header = await p.getHeader();
  const metadata = await p.getMetadata();
  console.log('header:', JSON.stringify({
    specVersion: header.specVersion,
    tileType: header.tileType, tileTypeName: Object.keys(TileType).find((k) => TileType[k] === header.tileType),
    tileCompression: header.tileCompression,
    internalCompression: header.internalCompression,
    minZoom: header.minZoom, maxZoom: header.maxZoom,
    numAddressedTiles: header.numAddressedTiles, numTileEntries: header.numTileEntries, numTileContents: header.numTileContents,
    clustered: header.clustered,
    bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
  }));
  console.log('metadata:', JSON.stringify(metadata));

  // Re-tile the source to know what should be in there.
  const sample = samples()[0];
  const world = readWorld(sample.path);
  const r = tileWorld(world, opts);
  const keys = [...r.tiles.keys()].sort();

  // Read back only some of the tiles - the point of range access.
  const picked = keys.filter((_, i) => i % 2 === 0);
  let checked = 0, buildings = 0, worstMeters = 0;
  for (const key of picked) {
    const [z, x, y] = key.split('/').map(Number);
    const res = await p.getZxy(z, x, y);
    if (!res) throw new Error(`tile ${key} missing from the archive`);
    const tile = decodeTile(Buffer.from(res.data));
    const expected = r.tiles.get(key);
    const expectedDecoded = decodeTile(expected.bytes);
    if (JSON.stringify(tile) !== JSON.stringify(expectedDecoded)) throw new Error(`tile ${key} round-trip mismatch`);

    // geometry error: decoded lng/lat vs the source document
    for (const b of tile.layers.buildings ?? []) {
      buildings++;
      const src = world.buildings.find((s) => s.id === b.id);
      if (!src) throw new Error(`building ${b.id} is not in the source world`);
      for (let i = 0; i < b.footprint.length; i++) {
        const [u, v] = b.footprint[i];
        const ll = fromTileLocal(u, v, z, x, y, tile.extent);
        const s = src.footprint[i];
        const srcLng = world.origin.lng + (s[0] * world.unitMeters) / (111320 * Math.cos((world.origin.lat * Math.PI) / 180));
        const srcLat = world.origin.lat - (s[1] * world.unitMeters) / 110540;
        const dx = (ll.lng - srcLng) * 111320 * Math.cos((srcLat * Math.PI) / 180);
        const dy = (ll.lat - srcLat) * 110540;
        worstMeters = Math.max(worstMeters, Math.hypot(dx, dy));
      }
    }
    checked++;
  }
  serving.close();
  console.log(JSON.stringify({
    transport: 'HTTP byte ranges against a single .pmtiles file',
    archiveBytes: serving.fileBytes,
    httpRequests: serving.counters.requests,
    httpBytesTransferred: serving.counters.bytes,
    tilesInArchive: keys.length,
    tilesReadBack: checked,
    buildingsChecked: buildings,
    worstVertexErrorMeters: Number(worstMeters.toFixed(4)),
    quantisationStepMeters: Number(tileUnitMeters(opts.zoom, world.origin.lat, opts.extent).toFixed(4)),
  }, null, 2));
}

const ZOOMS = [13, 14, 15, 16, 17];

/** Per-sample density at every zoom. Shared by `measure` and `extrapolate`. */
function measureAll(opts) {
  const rows = [];
  for (const s of samples()) {
    const world = readWorld(s.path);
    const areaKm2 = worldAreaKm2(world);
    const raw = readFileSync(s.path);
    const row = {
      sample: s.name,
      areaKm2: Number(areaKm2.toFixed(3)),
      features: featureCount(world),
      buildings: world.buildings.length,
      roads: world.roads.length,
      jsonKBperKm2: Number((raw.length / 1024 / areaKm2).toFixed(1)),
      jsonGzipKBperKm2: Number((gzipSync(raw, { level: 9 }).length / 1024 / areaKm2).toFixed(1)),
      byZoom: {},
    };
    for (const zoom of ZOOMS) {
      const r = tileWorld(world, { ...opts, zoom });
      const gz = [...r.tiles.values()].map((t) => gzipSync(t.bytes, { level: 9 }).length);
      const rawBytes = [...r.tiles.values()].map((t) => t.bytes.length);
      const tileAreaKm2 = tileGroundAreaKm2(zoom, 0, latToTileY(world.origin.lat, zoom));
      row.byZoom[zoom] = {
        tilesTouched: r.tiles.size,
        mtilKBperKm2: Number((sum(rawBytes) / 1024 / areaKm2).toFixed(1)),
        mtilGzipKBperKm2: Number((sum(gz) / 1024 / areaKm2).toFixed(2)),
        tileAreaKm2: Number(tileAreaKm2.toFixed(3)),
        tileEdgeMeters: Math.round(tileGroundMeters(zoom, world.origin.lat)),
        // a full tile at this density, from KB/km² x the tile's own ground area
        fullTileGzipKB: Number(((sum(gz) / areaKm2) * tileAreaKm2 / 1024).toFixed(1)),
        clippedParts: r.stats.clippedParts,
        buildingOverflowMeters: Number((r.stats.buildingOverflowUnits * tileUnitMeters(zoom, world.origin.lat, opts.extent)).toFixed(1)),
        quantStepMeters: Number(tileUnitMeters(zoom, world.origin.lat, opts.extent).toFixed(3)),
        msPerKm2: Number((r.ms.total / areaKm2).toFixed(1)),
      };
    }
    rows.push(row);
  }
  return rows;
}

function latToTileY(lat, z) {
  const s = Math.sin((lat * Math.PI) / 180);
  const my = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return Math.min(2 ** z - 1, Math.floor(my * 2 ** z));
}

async function cmdMeasure(opts) {
  console.log(JSON.stringify({ extent: opts.extent, buffer: opts.buffer, rows: measureAll(opts) }, null, 2));
}

/**
 * South Korea totals.
 *
 * The land-cover split below is an ASSUMPTION, not a measurement: roughly
 * "forest ~63 %, farmland ~19 %, everything built-up ~17 %" is the commonly
 * quoted shape of South Korea's land use. The spike has not verified it, so the
 * command prints three scenarios and the sensitivity instead of one number.
 */
const SCENARIOS = {
  // share of the 100 000 km² that behaves like each measured sample
  conservative: { gangnam: 0.03, busan: 0.05, seongsu: 0.05, bundang: 0.12, gurye: 0.10, farmland: 0.25, mountain: 0.40 },
  central: { gangnam: 0.015, busan: 0.03, seongsu: 0.03, bundang: 0.08, gurye: 0.08, farmland: 0.20, mountain: 0.565 },
  uniformDense: { seongsu: 1 },
};

async function cmdExtrapolate(opts) {
  const rows = measureAll(opts);
  const byName = Object.fromEntries(rows.map((r) => [r.sample, r]));
  const AREA_KM2 = 100_000;
  const out = { note: 'land-cover weights are an assumption, see cli.mjs SCENARIOS', areaKm2: AREA_KM2, zooms: {} };
  for (const zoom of ZOOMS) {
    const tileArea = byName.seongsu.byZoom[zoom].tileAreaKm2;
    const perScenario = {};
    for (const [name, weights] of Object.entries(SCENARIOS)) {
      let kbPerKm2 = 0, msPerKm2 = 0, missing = [];
      let coveredWeight = 0;
      for (const [sample, w] of Object.entries(weights)) {
        const row = byName[sample];
        if (!row) { missing.push(sample); continue; }
        kbPerKm2 += w * row.byZoom[zoom].mtilGzipKBperKm2;
        msPerKm2 += w * row.byZoom[zoom].msPerKm2;
        coveredWeight += w;
      }
      const totalGB = (kbPerKm2 * AREA_KM2) / 1024 / 1024;
      // tiles that actually carry something: everything but the empty-mountain share
      const nonEmptyShare = Object.entries(weights).filter(([s]) => s !== 'mountain').reduce((a, [, w]) => a + w, 0);
      const tiles = Math.round((AREA_KM2 / tileArea) * nonEmptyShare);
      perScenario[name] = {
        weightsCovered: Number(coveredWeight.toFixed(3)),
        missingSamples: missing,
        kbPerKm2: Number(kbPerKm2.toFixed(2)),
        totalGB: Number(totalGB.toFixed(2)),
        nonEmptyTiles: tiles,
        meanTileKB: tiles ? Number(((totalGB * 1024 * 1024) / tiles).toFixed(1)) : 0,
        buildMinutesSingleCore: Number(((msPerKm2 * AREA_KM2) / 1000 / 60).toFixed(1)),
      };
    }
    out.zooms[zoom] = {
      tileAreaKm2: tileArea,
      tileEdgeMeters: byName.seongsu.byZoom[zoom].tileEdgeMeters,
      allTilesIfFullyCovered: Math.round(AREA_KM2 / tileArea),
      scenarios: perScenario,
    };
  }
  console.log(JSON.stringify(out, null, 2));
}

/**
 * How big the PMTiles directory gets for a nationwide archive.
 *
 * Not a guess: it lays real z/x/y tile ids over the South Korea bounding box,
 * keeps a deterministic subset (the tiles that would hold data), and serialises
 * them with the same directory encoder the writer uses.
 */
async function cmdDirectory(opts) {
  const { serializeDirectory } = await import('./pmtiles-write.mjs');
  const { zxyToTileId } = await import('pmtiles');
  const KOREA = { west: 126.0, east: 129.7, south: 33.1, north: 38.6 };
  const zoom = opts.zoom;
  const n = 2 ** zoom;
  const xs = [Math.floor(((KOREA.west + 180) / 360) * n), Math.floor(((KOREA.east + 180) / 360) * n)];
  const ys = [latToTileY(KOREA.north, zoom), latToTileY(KOREA.south, zoom)];

  // deterministic ~keepRatio subset, standing in for "tiles that hold data"
  const keepRatio = Number(opts.keep ?? 0.33);
  const ids = [];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let x = xs[0]; x <= xs[1]; x++) {
    for (let y = ys[0]; y <= ys[1]; y++) {
      if (rnd() < keepRatio) ids.push(Number(zxyToTileId(zoom, x, y)));
    }
  }
  ids.sort((a, b) => a - b);

  // plausible tile lengths so the varints are realistic
  let offset = 0;
  const entries = ids.map((tileId) => {
    const length = 2000 + Math.floor(rnd() * 30000);
    const e = { tileId, offset, length, runLength: 1 };
    offset += length;
    return e;
  });

  const flat = serializeDirectory(entries);
  const flatGz = gzipSync(flat, { level: 9 });

  // two-level layout: root points at leaves of `leafSize` entries each
  const leafSize = Number(opts.leafSize ?? 4000);
  const leaves = [];
  for (let i = 0; i < entries.length; i += leafSize) leaves.push(entries.slice(i, i + leafSize));
  let leafOffset = 0;
  const rootEntries = leaves.map((leaf) => {
    const bytes = gzipSync(serializeDirectory(leaf), { level: 9 });
    const e = { tileId: leaf[0].tileId, offset: leafOffset, length: bytes.length, runLength: 0 };
    leafOffset += bytes.length;
    return { entry: e, bytes };
  });
  const rootGz = gzipSync(serializeDirectory(rootEntries.map((r) => r.entry)), { level: 9 });

  console.log(JSON.stringify({
    zoom,
    tilesInBbox: (xs[1] - xs[0] + 1) * (ys[1] - ys[0] + 1),
    keepRatio,
    entries: entries.length,
    singleDirectory: { bytes: flat.length, gzipBytes: flatGz.length, gzipBytesPerEntry: Number((flatGz.length / entries.length).toFixed(2)) },
    twoLevel: {
      leafSize,
      leaves: leaves.length,
      rootGzipBytes: rootGz.length,
      rootFitsIn16KB: rootGz.length <= 16384,
      leafGzipBytesTotal: leafOffset,
      meanLeafGzipBytes: Math.round(leafOffset / leaves.length),
    },
    firstFetchBytes: 16384,
    requestsPerTileColdCache: 3,
    note: 'a cold client reads header+root (one 16 KB range), then one leaf, then the tile: 3 range requests; afterwards 1 per tile',
  }, null, 2));
}

/** Full-detail vs overview profile, side by side, at every zoom. */
async function cmdProfiles(opts) {
  const out = [];
  for (const s of samples()) {
    const world = readWorld(s.path);
    const areaKm2 = worldAreaKm2(world);
    const row = { sample: s.name, areaKm2: Number(areaKm2.toFixed(3)) };
    for (const profile of ['detail', 'overview']) {
      row[profile] = {};
      for (const zoom of [11, 12, 13, 14, 15]) {
        const r = tileWorld(world, { ...opts, zoom, profile });
        const gz = sum([...r.tiles.values()].map((t) => gzipSync(t.bytes, { level: 9 }).length));
        const tileArea = tileGroundAreaKm2(zoom, 0, latToTileY(world.origin.lat, zoom));
        row[profile][zoom] = {
          kbPerKm2: Number((gz / 1024 / areaKm2).toFixed(2)),
          fullTileKB: Number(((gz / areaKm2) * tileArea / 1024).toFixed(1)),
        };
      }
    }
    out.push(row);
  }
  console.log(JSON.stringify(out, null, 2));
}

const COMMANDS = { profiles: cmdProfiles, build: cmdBuild, verify: cmdVerify, measure: cmdMeasure, extrapolate: cmdExtrapolate, directory: cmdDirectory };

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'build';
const opts = { ...DEFAULTS };
for (let i = 1; i < argv.length; i++) {
  const m = /^--(zoom|extent|buffer|keep|leafSize)$/.exec(argv[i]);
  if (argv[i] === '--profile') { opts.profile = argv[++i]; continue; }
  if (m) opts[m[1]] = Number(argv[++i]);
}
if (cmd === 'verify') await cmdVerify(argv[1] ?? join(OUT, `seongsu.z${opts.zoom}.pmtiles`), opts);
else if (COMMANDS[cmd]) await COMMANDS[cmd](opts);
else { console.error(`unknown command ${cmd}`); process.exit(1); }
