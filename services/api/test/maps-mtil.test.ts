// Maprama world archives (MTIL, `design/tile-format.md`) declare PMTiles `tile_type = 0 (Unknown)`
// because the enum has no value for our payload. The tile route used to reject exactly that with
// "not a vector tileset", which made our own archives unservable through our own service.
import { describe, expect, it } from 'vitest';
import { BLOB_KEYS } from '../src/config.js';
import { createHarness } from './helpers/harness.js';
import { buildPmtiles } from './helpers/pmtiles-writer.js';

const enc = (s: string) => new TextEncoder().encode(s);

const worldArchive = (): Uint8Array =>
  buildPmtiles({
    tiles: [{ z: 15, x: 27997, y: 12727, data: enc('MTIL seongsu z15') }],
    metadata: { name: 'Seongsu world tiles', attribution: '© OpenStreetMap contributors' },
    minZoom: 15,
    maxZoom: 15,
    bounds: [126.9, 37.4, 127.2, 37.7],
    center: [127.0559, 37.5446, 15],
    tileType: 0,
  });

const vectorArchive = (): Uint8Array =>
  buildPmtiles({
    tiles: [{ z: 0, x: 0, y: 0, data: enc('fake-mvt 0/0/0') }],
    metadata: { name: 'Demo tiles' },
    minZoom: 0,
    maxZoom: 0,
    bounds: [126.9, 37.4, 127.2, 37.7],
    center: [127.0559, 37.5446, 0],
  });

describe('Maprama world archives (MTIL)', () => {
  it('serves an Unknown-type archive as .mtil', async () => {
    const h = createHarness();
    const key = await h.addKey();
    await h.deps.blobs.put(BLOB_KEYS.tiles('world'), worldArchive(), 'application/octet-stream');

    const res = await h.request('/v1/tiles/world/15/27997/12727.mtil', { key, headers: { 'accept-encoding': 'gzip;q=0' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(new TextDecoder().decode(await res.arrayBuffer())).toContain('MTIL');
  });

  it('advertises the extension the archive is actually served under', async () => {
    const h = createHarness();
    const key = await h.addKey();
    await h.deps.blobs.put(BLOB_KEYS.tiles('world'), worldArchive(), 'application/octet-stream');

    const tj = (await (await h.request('/v1/tiles/world.json', { key })).json()) as { tiles: string[] };
    expect(tj.tiles[0]).toContain('{z}/{x}/{y}.mtil');
  });

  it('refuses the wrong extension for the archive it holds', async () => {
    const h = createHarness();
    const key = await h.addKey();
    await h.deps.blobs.put(BLOB_KEYS.tiles('world'), worldArchive(), 'application/octet-stream');
    await h.deps.blobs.put(BLOB_KEYS.tiles('demo'), vectorArchive(), 'application/octet-stream');

    // A wrong extension fails loudly rather than handing back bytes the caller cannot parse.
    expect((await h.request('/v1/tiles/world/15/27997/12727.mvt', { key })).status).toBe(404);
    expect((await h.request('/v1/tiles/demo/0/0/0.mtil', { key })).status).toBe(404);
    // Anything that is neither stays a bad request.
    expect((await h.request('/v1/tiles/demo/0/0/0.png', { key })).status).toBe(400);
  });
});
