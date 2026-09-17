/** The MTIL v1 payload: round trip, forward compatibility, attribution. */

import { describe, expect, it } from 'vitest';
import { FLAG_CLIPPED, MAGIC, decodeTile, encodeTile } from '../src/mtil.js';
import { emptyLayers, type TileLayers } from '../src/types.js';

function sample(): TileLayers {
  const layers = emptyLayers();
  layers.roads.push(
    { id: 'w1', cls: 'arterial', name: '강변북로', pts: [[0, 0], [100, 40], [8192, 900]] },
    { id: 'w2#1', cls: 'alley', bridge: true, pts: [[-256, 10], [40, 60]] },
  );
  layers.buildings.push({
    id: 'w9',
    heightDm: 421,
    levels: 14,
    kind: 'glass',
    name: '사옥',
    footprint: [[10, 10], [80, 10], [80, 90], [10, 90]],
  });
  layers.water.push({ poly: [[-256, -256], [8448, -256], [8448, 4000], [-256, 4000]] });
  layers.parks.push({ name: '서울숲', poly: [[1, 2], [3, 4], [5, 6]] });
  layers.pois.push(
    { id: 'n1', name: '카페', cat: 'cafe', buildingId: 'w9', u: 40, v: 50 },
    { id: 'n2', name: '서점', cat: 'book', snapped: true, snapDistanceMeters: 3.4, u: 44, v: 55 },
  );
  layers.stations.push({ id: 'n7', name: '뚝섬역', u: 900, v: 120 });
  layers.districts.push({ name: '한강', water: true, u: 4000, v: 4000 });
  return layers;
}

describe('encodeTile / decodeTile', () => {
  it('round-trips every layer', () => {
    const layers = sample();
    const bytes = encodeTile({ extent: 8192, buffer: 256, attribution: [0, 1], layers });
    expect(bytes.subarray(0, 4).equals(MAGIC)).toBe(true);
    expect(bytes[4]).toBe(1);
    expect(bytes[5]).toBe(FLAG_CLIPPED);

    const tile = decodeTile(bytes);
    expect(tile.extent).toBe(8192);
    expect(tile.buffer).toBe(256);
    expect(tile.clipped).toBe(true);
    expect(tile.attribution).toEqual([0, 1]);
    expect(tile.layers).toEqual(layers);
  });

  it('omits empty layers entirely', () => {
    const layers = emptyLayers();
    layers.water.push({ poly: [[0, 0], [10, 0], [10, 10]] });
    const tile = decodeTile(encodeTile({ extent: 4096, buffer: 128, attribution: [0], layers }));
    expect(tile.layers.roads).toEqual([]);
    expect(tile.layers.water).toHaveLength(1);
  });

  it('carries attribution indices on every tile', () => {
    const layers = emptyLayers();
    layers.districts.push({ name: '아무데나', u: 1, v: 1 });
    for (const attribution of [[0], [0, 1], [1]]) {
      expect(decodeTile(encodeTile({ extent: 8192, buffer: 256, attribution, layers })).attribution).toEqual(
        attribution,
      );
    }
  });

  it('skips a layer id it does not know', () => {
    const layers = emptyLayers();
    layers.stations.push({ id: 'n7', name: '역', u: 5, v: 6 });
    const bytes = encodeTile({ extent: 8192, buffer: 256, attribution: [0], layers });
    // Re-label the single layer as an unknown id 99; its byteLength lets a
    // reader step over it, which is what §4.4 promises.
    const patched = Buffer.from(bytes);
    const idOffset = patched.indexOf(6, 10);
    patched[idOffset] = 99;
    const tile = decodeTile(patched);
    expect(tile.layers.stations).toEqual([]);
  });

  it('rejects foreign bytes and future versions', () => {
    expect(() => decodeTile(Buffer.from('NOPE0000'))).toThrow(/not an MTIL tile/);
    const bytes = encodeTile({ extent: 8192, buffer: 256, attribution: [], layers: emptyLayers() });
    bytes[4] = 2;
    expect(() => decodeTile(bytes)).toThrow(/unsupported MTIL version 2/);
  });

  it('is byte-identical for identical input', () => {
    const a = encodeTile({ extent: 8192, buffer: 256, attribution: [0], layers: sample() });
    const b = encodeTile({ extent: 8192, buffer: 256, attribution: [0], layers: sample() });
    expect(a.equals(b)).toBe(true);
  });
});
