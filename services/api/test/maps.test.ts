import { gunzipSync } from 'node:zlib';
import { PMTiles, bytesToHeader } from 'pmtiles';
import { describe, expect, it } from 'vitest';
import { MemoryBlobStore } from '../src/adapters/memory/index.js';
import { BLOB_KEYS } from '../src/config.js';
import { BlobRangeSource, buildTileJson } from '../src/tiles/pmtiles.js';
import { createHarness, json } from './helpers/harness.js';
import { buildPmtiles } from './helpers/pmtiles-writer.js';

const enc = (s: string) => new TextEncoder().encode(s);
const TILE_000 = enc('fake-mvt 0/0/0');
const TILE_211 = enc('fake-mvt 2/3/1 with a longer body '.repeat(10));

function fixtureArchive(tileCompression: 1 | 2 = 2): Uint8Array {
  return buildPmtiles({
    tiles: [
      { z: 0, x: 0, y: 0, data: TILE_000 },
      { z: 2, x: 3, y: 1, data: TILE_211 },
      { z: 1, x: 1, y: 0, data: new Uint8Array(0) },
    ],
    metadata: { name: 'Demo tiles', vector_layers: [{ id: 'roads', fields: { class: 'String' } }], attribution: '© OpenStreetMap contributors' },
    minZoom: 0,
    maxZoom: 2,
    bounds: [126.9, 37.4, 127.2, 37.7],
    center: [127.0559, 37.5446, 2],
    tileCompression,
  });
}

describe('world data', () => {
  it('serves WorldData JSON with ETag, long cache headers and 304 revalidation', async () => {
    const h = createHarness();
    const key = await h.addKey();
    const world = JSON.stringify({ version: 1, name: 'Seongsu' });
    await h.deps.blobs.put(BLOB_KEYS.world('seongsu'), world, 'application/json');

    const res = await h.request('/v1/worlds/seongsu.json', { key });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(world);
    const etag = res.headers.get('ETag');
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(res.headers.get('Cache-Control')).toContain('max-age=86400');
    expect(res.headers.get('Content-Type')).toContain('application/json');

    const again = await h.request('/v1/worlds/seongsu.json', { key, headers: { 'if-none-match': etag! } });
    expect(again.status).toBe(304);
    expect(again.headers.get('ETag')).toBe(etag);
  });

  it('returns 404 for unknown worlds and 400 for bad names', async () => {
    const h = createHarness();
    const key = await h.addKey();
    expect((await h.request('/v1/worlds/nowhere.json', { key })).status).toBe(404);
    expect((await h.request('/v1/worlds/Bad..Name.json', { key })).status).toBe(400);
    expect((await h.request('/v1/worlds/seongsu.xml', { key })).status).toBe(400);
  });
});

describe('PMTiles range source and TileJSON', () => {
  it('reads the header through byte ranges only and parses it', async () => {
    const blobs = new MemoryBlobStore();
    await blobs.put('tiles/demo.pmtiles', fixtureArchive());
    const archive = new PMTiles(new BlobRangeSource(blobs, 'tiles/demo.pmtiles'));
    const header = await archive.getHeader();
    expect(header).toMatchObject({ specVersion: 3, minZoom: 0, maxZoom: 2, tileType: 1, tileCompression: 2 });
    expect(header.minLon).toBeCloseTo(126.9, 6);
    expect(header.maxLat).toBeCloseTo(37.7, 6);
    expect(blobs.rangeReads[0]).toEqual({ key: 'tiles/demo.pmtiles', offset: 0, length: 16384 });

    const raw = fixtureArchive();
    const direct = bytesToHeader(raw.slice(0, 127).buffer);
    const tj = buildTileJson('demo', direct, await archive.getMetadata(), 'https://api.example/v1/tiles/demo/{z}/{x}/{y}.mvt');
    expect(tj).toEqual({
      tilejson: '3.0.0',
      name: 'Demo tiles',
      attribution: '© OpenStreetMap contributors',
      scheme: 'xyz',
      tiles: ['https://api.example/v1/tiles/demo/{z}/{x}/{y}.mvt'],
      minzoom: 0,
      maxzoom: 2,
      bounds: [126.9, 37.4, 127.2, 37.7],
      center: [127.0559, 37.5446, 2],
      vector_layers: [{ id: 'roads', fields: { class: 'String' } }],
    });
  });

  it('serves TileJSON with tile URLs that carry the query key', async () => {
    const h = createHarness();
    const key = await h.addKey();
    await h.deps.blobs.put(BLOB_KEYS.tiles('demo'), fixtureArchive());
    const res = await h.app.request(`http://api.test/v1/tiles/demo.json?key=${key}`);
    expect(res.status).toBe(200);
    const tj = await json<{ tiles: string[]; minzoom: number; maxzoom: number }>(res);
    expect(tj.tiles).toEqual([`http://api.test/v1/tiles/demo/{z}/{x}/{y}.mvt?key=${key}`]);
    expect([tj.minzoom, tj.maxzoom]).toEqual([0, 2]);

    const viaHeader = await json<{ tiles: string[] }>(await h.request('/v1/tiles/demo.json', { key }));
    expect(viaHeader.tiles[0]).not.toContain('key=');
  });
});

describe('vector tiles', () => {
  it('gzips for clients that accept gzip and serves identity otherwise', async () => {
    const h = createHarness();
    const key = await h.addKey();
    await h.deps.blobs.put(BLOB_KEYS.tiles('demo'), fixtureArchive(2));

    const gz = await h.request('/v1/tiles/demo/2/3/1.mvt', { key, headers: { 'accept-encoding': 'gzip, br' } });
    expect(gz.status).toBe(200);
    expect(gz.headers.get('Content-Type')).toBe('application/vnd.mapbox-vector-tile');
    expect(gz.headers.get('Content-Encoding')).toBe('gzip');
    expect(gz.headers.get('Vary')).toContain('Accept-Encoding');
    expect(new Uint8Array(gunzipSync(new Uint8Array(await gz.arrayBuffer())))).toEqual(TILE_211);

    const plain = await h.request('/v1/tiles/demo/2/3/1.mvt', { key, headers: { 'accept-encoding': 'gzip;q=0' } });
    expect(plain.headers.get('Content-Encoding')).toBeNull();
    expect(new Uint8Array(await plain.arrayBuffer())).toEqual(TILE_211);

    const viaQuery = await h.app.request(`/v1/tiles/demo/0/0/0.mvt?key=${key}`);
    expect(viaQuery.status).toBe(200);
    expect(new Uint8Array(await viaQuery.arrayBuffer())).toEqual(TILE_000);
    expect(h.deps.blobs.rangeReads.every((r) => r.key === BLOB_KEYS.tiles('demo'))).toBe(true);
  });

  it('works with uncompressed archives and runtime encoding mode', async () => {
    const h = createHarness({ options: { tileEncoding: 'runtime' } });
    const key = await h.addKey();
    await h.deps.blobs.put(BLOB_KEYS.tiles('plain'), fixtureArchive(1));
    const res = await h.request('/v1/tiles/plain/2/3/1.mvt', { key, headers: { 'accept-encoding': 'gzip' } });
    expect(res.status).toBe(200);
    // Runtime mode: header set, body left for the Workers runtime to encode.
    expect(res.headers.get('Content-Encoding')).toBe('gzip');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(TILE_211);
  });

  it('returns 204 for empty/missing/out-of-zoom tiles, 404 for unknown tilesets, 400 for bad paths', async () => {
    const h = createHarness();
    const key = await h.addKey();
    await h.deps.blobs.put(BLOB_KEYS.tiles('demo'), fixtureArchive());
    expect((await h.request('/v1/tiles/demo/2/0/0.mvt', { key })).status).toBe(204);
    expect((await h.request('/v1/tiles/demo/1/1/0.mvt', { key })).status).toBe(204);
    const deep = await h.request('/v1/tiles/demo/5/1/1.mvt', { key });
    expect(deep.status).toBe(204);
    expect(deep.headers.get('Cache-Control')).toContain('max-age');
    expect((await h.request('/v1/tiles/missing/0/0/0.mvt', { key })).status).toBe(404);
    expect((await h.request('/v1/tiles/missing.json', { key })).status).toBe(404);
    expect((await h.request('/v1/tiles/demo/2/4/0.mvt', { key })).status).toBe(400);
    expect((await h.request('/v1/tiles/demo/2/1/1.png', { key })).status).toBe(400);
  });

  it('meters tiles as billable units', async () => {
    const h = createHarness();
    const key = await h.addKey({ quota: 2 });
    await h.deps.blobs.put(BLOB_KEYS.tiles('demo'), fixtureArchive());
    expect((await h.request('/v1/tiles/demo/0/0/0.mvt', { key })).status).toBe(200);
    expect((await h.request('/v1/tiles/demo/2/0/0.mvt', { key })).status).toBe(204);
    expect((await h.request('/v1/tiles/demo/0/0/0.mvt', { key })).status).toBe(429);
  });
});
