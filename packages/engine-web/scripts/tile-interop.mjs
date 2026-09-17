#!/usr/bin/env node
/**
 * Interoperability check: an archive written by the **production pipeline**
 * (`@maprama/tiles`) read by the **engine**.
 *
 *   npm run build -w @maprama/protocol && npm run build -w @maprama/osm \
 *     && npm run build -w @maprama/tiles
 *   node --import tsx scripts/tile-interop.mjs
 *
 * Everything else in this repository tests the two halves separately: the
 * pipeline has its own tests, and the engine's harnesses run against a fixture
 * this package generates. That leaves the one thing that actually matters
 * untested — that bytes written by one are understood by the other. This script
 * closes it: it tiles the checked-in Seongsu `WorldData` sample with the
 * pipeline's own tiler and archive writer, serves the result over HTTP with
 * range support, and opens it with the engine's `TileWorld`.
 *
 * It uses the sample already in the repository, so it needs no network and no
 * `.pbf` extract.
 */

import { createServer } from 'node:http';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(root, '..', '..');

const tiles = await import('@maprama/tiles').catch((e) => {
  throw new Error(`tile-interop: cannot import @maprama/tiles (run \`npm run build -w @maprama/tiles\`): ${e.message}`);
});
const {
  ArchiveWriter,
  Compression,
  DEFAULT_LAYER_ROUTING,
  TileType,
  attributionIndices,
  attributionTable,
  encodeTile,
  filterForOverview,
  tileAttribution,
  tileBundle,
  worldToGeo,
  zxyToTileId,
} = tiles;

const world = JSON.parse(readFileSync(join(repo, 'tools/osm/samples/seongsu.world.json'), 'utf8'));
const geo = worldToGeo(world);

const DETAIL_Z = 15;
const OVERVIEW_Z = 13;
const EXTENT = 8192;
const BUFFER = 256;

// One registered source, exactly as the nationwide build routes it today.
const sources = [{ id: 'osm', attribution: world.attribution, layers: undefined }];
const routing = DEFAULT_LAYER_ROUTING;
const attribution = attributionTable(sources, routing);
const indices = attributionIndices(sources, routing);

const built = [];
for (const [z, bundle] of [
  [OVERVIEW_Z, filterForOverview(geo)],
  [DETAIL_Z, geo],
]) {
  const result = tileBundle(bundle, { zoom: z, extent: EXTENT, buffer: BUFFER, origin: routing });
  for (const t of result.tiles.values()) {
    built.push({
      z,
      x: t.x,
      y: t.y,
      body: gzipSync(encodeTile({ extent: EXTENT, buffer: BUFFER, attribution: tileAttribution(t.sources, indices), layers: t.layers }), { level: 9 }),
    });
  }
}
if (built.length === 0) throw new Error('tile-interop: the pipeline produced no tiles');

const scratch = join(tmpdir(), `maprama-interop-${process.pid}.bin`);
const archivePath = join(tmpdir(), `maprama-interop-${process.pid}.pmtiles`);
const writer = new ArchiveWriter(scratch);
for (const t of built.sort((a, b) => zxyToTileId(a.z, a.x, a.y) - zxyToTileId(b.z, b.x, b.y))) writer.add(t.z, t.x, t.y, t.body);
const proj0 = world.origin;
await writer.finish(archivePath, {
  metadata: {
    format: 'maprama-mtil-1',
    name: world.name,
    extent: EXTENT,
    buffer: BUFFER,
    attribution,
    layers: ['roads', 'buildings', 'water', 'parks', 'pois', 'stations', 'districts'],
    profiles: { [String(OVERVIEW_Z)]: 'overview', [String(DETAIL_Z)]: 'detail' },
  },
  bounds: { west: proj0.lng - 0.02, south: proj0.lat - 0.02, east: proj0.lng + 0.02, north: proj0.lat + 0.02 },
  center: { lng: proj0.lng, lat: proj0.lat, z: DETAIL_Z },
  tileType: TileType.Unknown,
  tileCompression: Compression.Gzip,
});
const buffer = readFileSync(archivePath);
console.log(`tile-interop: @maprama/tiles wrote ${built.length} tiles into ${(buffer.length / 1024).toFixed(1)} KiB`);

let requests = 0;
const server = createServer((req, res) => {
  requests++;
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'Content-Range, Content-Length, ETag, Accept-Ranges',
    'accept-ranges': 'bytes',
    etag: '"interop"',
  };
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  if (!range) {
    res.writeHead(200, { ...cors, 'content-length': String(buffer.length) });
    res.end(buffer);
    return;
  }
  const start = Number(range[1]);
  const end = Math.min(range[2] ? Number(range[2]) : buffer.length - 1, buffer.length - 1);
  const slice = buffer.subarray(start, end + 1);
  res.writeHead(206, { ...cors, 'content-range': `bytes ${start}-${end}/${buffer.length}`, 'content-length': String(slice.length) });
  res.end(slice);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/seongsu.pmtiles`;

const { TileWorld } = await import(join(root, 'src/tiles/world.ts'));
const centre = { lng: world.origin.lng, lat: world.origin.lat };
const tw = await TileWorld.open({ kind: 'tiles', url, center: centre }, { onChange: () => {}, onWarning: (m) => console.log('WARN', m) });

const corners = (r) => [
  { x: -r, z: -r },
  { x: r, z: -r },
  { x: r, z: r },
  { x: -r, z: r },
];
for (let i = 0; i < 25; i++) {
  const step = tw.step({ x: 0, z: 0 }, corners(60));
  if (!step.loading && i > 3) break;
  await new Promise((r) => setTimeout(r, 40));
}
tw.step({ x: 0, z: 0 }, corners(60));

const w = tw.world;
const stats = tw.stats();
const failures = [];
const check = (ok, what) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

check(stats.loaded > 0 && stats.failed === 0, `tiles read: ${stats.loaded} loaded (${stats.empty} empty), ${stats.failed} failed, level z${stats.zoom}`);
check(w.buildings.length > 0, `buildings decoded: ${w.buildings.length}`);
check(w.graph.edges.length > 0, `road graph built: ${w.graph.edges.length} edges`);
check(w.attribution.length > 0 && w.attribution.every((line) => world.attribution.includes(line)), `attribution came through the archive metadata: ${JSON.stringify(w.attribution)}`);
// A building of the source world must be in the streamed one, at the same place.
const sample = world.buildings[Math.floor(world.buildings.length / 2)];
const streamed = w.buildings.find((b) => b.id === sample.id);
if (streamed) {
  const proj = w.projection;
  const srcLngLat = {
    lng: world.origin.lng + (sample.footprint[0][0] * world.unitMeters) / (111320 * Math.cos((world.origin.lat * Math.PI) / 180)),
    lat: world.origin.lat - (sample.footprint[0][1] * world.unitMeters) / 110540,
  };
  const expected = proj.toWorld(srcLngLat);
  const got = streamed.footprint.reduce((best, p) => (Math.hypot(p[0] - expected.x, p[1] - expected.z) < Math.hypot(best[0] - expected.x, best[1] - expected.z) ? p : best));
  const errorMeters = Math.hypot(got[0] - expected.x, got[1] - expected.z) * w.unitMeters;
  check(errorMeters < 0.25, `building "${sample.id}" survived the round trip within ${errorMeters.toFixed(3)} m (quantisation limit is 0.118 m at z15 + the source's own 0.08 m rounding)`);
} else {
  check(false, `building "${sample.id}" is missing from the streamed world`);
}
console.log(`  http: ${requests} range requests`);

tw.dispose();
server.close();
rmSync(archivePath, { force: true });
rmSync(scratch, { force: true });
if (failures.length) {
  console.error(`\ntile-interop: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\ntile-interop: the pipeline writes what the engine reads');
