import { describe, expect, it } from 'vitest';
import {
  MTIL_BUFFER,
  MTIL_EXTENT,
  MTIL_FORMAT,
  MTIL_LAYERS,
  MTIL_LAYER_OWNERSHIP,
  TileDecodeError,
  decodeTile,
  resolveTileAttribution,
  validateTileArchiveMetadata,
  validateWorldSource,
} from './index.js';
import { encodeTile, sampleTileLayers } from './__fixtures__/tile.js';

const sample = (): Uint8Array => encodeTile({ attribution: [0, 1], layers: sampleTileLayers() });

describe('decodeTile', () => {
  it('round-trips every layer and every optional field', () => {
    const tile = decodeTile(sample());
    expect(tile.version).toBe(1);
    expect(tile.clipped).toBe(true);
    expect(tile.extent).toBe(MTIL_EXTENT);
    expect(tile.buffer).toBe(MTIL_BUFFER);
    expect(tile.attribution).toEqual([0, 1]);
    expect(tile.unknownLayers).toEqual([]);
    expect(tile.layers).toEqual(sampleTileLayers());
  });

  it('keeps coordinates that leave the tile in both directions', () => {
    const tile = decodeTile(sample());
    const road = tile.layers.roads![0]!;
    expect(road.pts[0]).toEqual([-256, 4096]);
    expect(road.pts[2]).toEqual([8448, 4100]);
    // an anchor-owned building may stick far out of its tile: it is never cut
    expect(tile.layers.buildings![1]!.footprint[0]).toEqual([-390, 8000]);
  });

  it('skips layer ids it does not know and reports them', () => {
    const bytes = encodeTile({
      layers: { stations: sampleTileLayers().stations! },
      unknownLayers: [{ id: 9, bytes: new Uint8Array([1, 2, 3, 4, 5]) }],
    });
    const tile = decodeTile(bytes);
    expect(tile.unknownLayers).toEqual([9]);
    expect(tile.layers.stations).toEqual(sampleTileLayers().stations);
  });

  it('accepts a tile with no layers at all', () => {
    const tile = decodeTile(encodeTile({ layers: {} }));
    expect(tile.layers).toEqual({});
    expect(tile.attribution).toEqual([]);
  });

  it('rejects bad magic, bad version and truncation', () => {
    expect(() => decodeTile(new Uint8Array(4))).toThrow(TileDecodeError);
    const bad = sample();
    bad[0] = 0x58;
    expect(() => decodeTile(bad)).toThrow(/bad magic/);
    const v = sample();
    v[4] = 2;
    expect(() => decodeTile(v)).toThrow(/unsupported MTIL version 2/);
    const full = sample();
    expect(() => decodeTile(full.subarray(0, full.length - 3))).toThrow(TileDecodeError);
  });

  it('never throws something other than TileDecodeError on arbitrary truncation', () => {
    const full = sample();
    for (let n = 0; n < full.length; n++) {
      try {
        decodeTile(full.subarray(0, n));
      } catch (e) {
        expect(e).toBeInstanceOf(TileDecodeError);
      }
    }
  });

  it('fixes the layer ids and ownership rules the format specifies', () => {
    expect(MTIL_LAYERS).toEqual({ roads: 1, buildings: 2, water: 3, parks: 4, pois: 5, stations: 6, districts: 7 });
    expect(MTIL_LAYER_OWNERSHIP.buildings).toBe('anchor');
    expect(MTIL_LAYER_OWNERSHIP.water).toBe('clip');
  });
});

describe('tile archive metadata', () => {
  it('validates the documented shape', () => {
    expect(
      validateTileArchiveMetadata({
        format: MTIL_FORMAT,
        name: 'South Korea',
        extent: 8192,
        buffer: 256,
        attribution: ['© OpenStreetMap contributors'],
        layers: ['roads'],
        profiles: { '13': 'overview', '15': 'detail' },
      }),
    ).toEqual({ ok: true });
    expect(validateTileArchiveMetadata({}).ok).toBe(false);
    expect(validateTileArchiveMetadata({ format: MTIL_FORMAT, extent: 0 }).ok).toBe(false);
  });

  it('resolves attribution indices and drops the ones that do not exist', () => {
    const table = ['© OpenStreetMap contributors', 'Heights: NSDI'];
    expect(resolveTileAttribution([0, 1], table)).toEqual(table);
    expect(resolveTileAttribution([1, 7, 1], table)).toEqual(['Heights: NSDI']);
    expect(resolveTileAttribution([0], undefined)).toEqual([]);
  });
});

describe("WorldSource { kind: 'tiles' }", () => {
  it('accepts the documented shape', () => {
    expect(validateWorldSource({ kind: 'tiles', url: 'https://cdn/kr.pmtiles', center: { lng: 127, lat: 37.5 } })).toEqual({ ok: true });
    expect(
      validateWorldSource({ kind: 'tiles', url: 'https://cdn/kr.pmtiles', center: { lng: 127, lat: 37.5 }, detailZoom: 15, overviewZoom: 13, tileBudget: 96 }),
    ).toEqual({ ok: true });
  });

  it('requires a url and a center, and rejects nonsense zooms', () => {
    expect(validateWorldSource({ kind: 'tiles', center: { lng: 127, lat: 37.5 } }).ok).toBe(false);
    expect(validateWorldSource({ kind: 'tiles', url: 'https://cdn/kr.pmtiles' }).ok).toBe(false);
    expect(validateWorldSource({ kind: 'tiles', url: 'u', center: { lng: 127, lat: 37.5 }, detailZoom: 15.5 }).ok).toBe(false);
    expect(validateWorldSource({ kind: 'tiles', url: 'u', center: { lng: 127, lat: 37.5 }, tileBudget: 0 }).ok).toBe(false);
  });

  it('leaves the existing kinds untouched', () => {
    expect(validateWorldSource({ kind: 'url', url: 'https://example.com/world.json' })).toEqual({ ok: true });
    expect(validateWorldSource({ kind: 'procedural', layout: 'town' })).toEqual({ ok: true });
    expect(validateWorldSource({ kind: 'nope' }).ok).toBe(false);
  });
});
