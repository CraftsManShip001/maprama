/**
 * The two ownership rules of `design/tile-format.md` §3, and the synthetic-edge
 * test that keeps a riverbank off a tile boundary.
 */

import { describe, expect, it } from 'vitest';
import { isSyntheticEdge, syntheticEdgeCount } from '../src/geometry.js';
import { tileBounds, type LngLat } from '../src/mercator.js';
import { filterForOverview, tileBundle } from '../src/tiler.js';
import { emptyBundle, LAYER_NAMES } from '../src/types.js';
import { DEFAULT_LAYER_ROUTING } from '../src/sources.js';

const Z = 15;
const EXTENT = 8192;
const BUFFER = 256;
// A tile over the Han river in Seoul, and its eastern neighbour.
const X = 27_982;
const Y = 12_666;
const origin = DEFAULT_LAYER_ROUTING;

const bounds = tileBounds(Z, X, Y);
const east = tileBounds(Z, X + 1, Y);
/** A point a fraction of the way across the tile. */
const at = (fx: number, fy: number): LngLat => [
  bounds.west + (bounds.east - bounds.west) * fx,
  bounds.north + (bounds.south - bounds.north) * fy,
];

describe('anchor-owned layers', () => {
  it('gives a building that straddles a boundary to exactly one tile, whole', () => {
    const geo = emptyBundle();
    // Centred on the eastern edge, so half of it lies in the next tile.
    geo.buildings.push({
      id: 'w1',
      heightDm: 300,
      footprint: [at(0.97, 0.5), at(1.03, 0.5), at(1.03, 0.55), at(0.97, 0.55)],
    });
    const { tiles } = tileBundle(geo, { zoom: Z, extent: EXTENT, buffer: BUFFER, origin });
    const owners = [...tiles.values()].filter((t) => t.layers.buildings.length > 0);
    expect(owners).toHaveLength(1);
    const ring = owners[0]!.layers.buildings[0]!.footprint;
    expect(ring).toHaveLength(4);
    // Whole geometry means coordinates outside [0, extent] — that is the
    // overhang §3.1 tells the renderer to allow for.
    const outside = ring.some(([u]) => u < 0 || u > EXTENT);
    expect(outside).toBe(true);
  });

  it('never emits the same building twice across neighbouring windows', () => {
    const geo = emptyBundle();
    geo.buildings.push({
      id: 'w1',
      heightDm: 300,
      footprint: [at(0.99, 0.5), at(1.01, 0.5), at(1.01, 0.52), at(0.99, 0.52)],
    });
    const left = tileBundle(geo, {
      zoom: Z,
      extent: EXTENT,
      buffer: BUFFER,
      window: { x0: X, x1: X, y0: Y, y1: Y },
      origin,
    });
    const right = tileBundle(geo, {
      zoom: Z,
      extent: EXTENT,
      buffer: BUFFER,
      window: { x0: X + 1, x1: X + 1, y0: Y, y1: Y },
      origin,
    });
    const count = (r: typeof left): number =>
      [...r.tiles.values()].reduce((n, t) => n + t.layers.buildings.length, 0);
    expect(count(left) + count(right)).toBe(1);
  });

  it('reports the overhang it produced', () => {
    const geo = emptyBundle();
    geo.buildings.push({
      id: 'w1',
      heightDm: 300,
      footprint: [at(0.95, 0.5), at(1.05, 0.5), at(1.05, 0.55), at(0.95, 0.55)],
    });
    const { stats } = tileBundle(geo, { zoom: Z, extent: EXTENT, buffer: BUFFER, origin });
    expect(stats.buildingOverflowUnits).toBeGreaterThan(0);
    expect(stats.wholeFeatures).toBe(1);
  });
});

describe('clipped layers', () => {
  it('cuts a river at the boundary and leaves the two halves meeting exactly', () => {
    const geo = emptyBundle();
    geo.water.push({
      poly: [
        [bounds.west + (bounds.east - bounds.west) * 0.5, at(0, 0.4)[1]],
        [east.west + (east.east - east.west) * 0.5, at(0, 0.4)[1]],
        [east.west + (east.east - east.west) * 0.5, at(0, 0.6)[1]],
        [bounds.west + (bounds.east - bounds.west) * 0.5, at(0, 0.6)[1]],
      ],
    });
    const { tiles } = tileBundle(geo, { zoom: Z, extent: EXTENT, buffer: BUFFER, origin });
    const left = tiles.get(`${X}/${Y}`)!;
    const right = tiles.get(`${X + 1}/${Y}`)!;
    expect(left.layers.water).toHaveLength(1);
    expect(right.layers.water).toHaveLength(1);

    // The left tile's cut is at extent + buffer; the right tile's at -buffer.
    // Same ground line, so they meet: (extent + buffer) - extent === -buffer + extent - extent.
    const leftMax = Math.max(...left.layers.water[0]!.poly.map(([u]) => u));
    const rightMin = Math.min(...right.layers.water[0]!.poly.map(([u]) => u));
    expect(leftMax).toBe(EXTENT + BUFFER);
    expect(rightMin).toBe(-BUFFER);

    // The v coordinates of the shared edge must be identical in both tiles —
    // this is what quantising once per vertex buys.
    const leftEdge = left.layers.water[0]!.poly.filter(([u]) => u === EXTENT + BUFFER).map(([, v]) => v).sort();
    const rightEdge = right.layers.water[0]!.poly.filter(([u]) => u === -BUFFER).map(([, v]) => v).sort();
    expect(leftEdge).toEqual(rightEdge);
  });

  it('marks the boundary cut as a synthetic edge — and the literal 0/extent rule misses it', () => {
    const geo = emptyBundle();
    // A river band running clean across the tile from west to east.
    geo.water.push({
      poly: [at(-0.5, 0.45), at(1.5, 0.45), at(1.5, 0.55), at(-0.5, 0.55)],
    });
    const { tiles } = tileBundle(geo, { zoom: Z, extent: EXTENT, buffer: BUFFER, origin });
    const ring = tiles.get(`${X}/${Y}`)!.layers.water[0]!.poly;

    // Two edges were created by the clip (the west and east cuts).
    expect(syntheticEdgeCount(ring, EXTENT, BUFFER)).toBe(2);
    // §3.2 words the rule as "0 or extent". Geometry is clipped to the tile
    // *plus the buffer*, so that wording finds nothing and the engine would
    // raise a bank right across the river.
    expect(syntheticEdgeCount(ring, EXTENT, 0)).toBe(0);

    // The real banks — the river's own north and south sides — stay.
    const real = ring.length - syntheticEdgeCount(ring, EXTENT, BUFFER);
    expect(real).toBeGreaterThanOrEqual(2);
  });

  it('splits a road into numbered parts only when the clip actually splits it', () => {
    const geo = emptyBundle();
    geo.roads.push({ id: 'w5', cls: 'arterial', pts: [at(0.1, 0.1), at(0.9, 0.9)] });
    const { tiles } = tileBundle(geo, { zoom: Z, extent: EXTENT, buffer: BUFFER, origin });
    expect(tiles.get(`${X}/${Y}`)!.layers.roads[0]!.id).toBe('w5');
  });

  it('keeps no tile in which every layer is empty', () => {
    const { tiles } = tileBundle(emptyBundle(), { zoom: Z, extent: EXTENT, buffer: BUFFER, origin });
    expect(tiles.size).toBe(0);
  });
});

describe('window', () => {
  it('drops everything outside it', () => {
    const geo = emptyBundle();
    geo.buildings.push({ id: 'a', heightDm: 100, footprint: [at(0.2, 0.2), at(0.3, 0.2), at(0.3, 0.3)] });
    geo.roads.push({ id: 'r', cls: 'local', pts: [at(0.1, 0.1), at(2.5, 0.1)] });
    const { tiles } = tileBundle(geo, {
      zoom: Z,
      extent: EXTENT,
      buffer: BUFFER,
      window: { x0: X, x1: X, y0: Y, y1: Y },
      origin,
    });
    expect([...tiles.keys()]).toEqual([`${X}/${Y}`]);
  });
});

describe('overview profile', () => {
  it('keeps only what is visible when zoomed out', () => {
    const geo = emptyBundle();
    geo.roads.push({ id: 'a', cls: 'arterial', pts: [at(0.1, 0.1), at(0.9, 0.9)] });
    geo.roads.push({ id: 'b', cls: 'alley', pts: [at(0.1, 0.2), at(0.2, 0.2)] });
    geo.buildings.push({ id: 'tall', heightDm: 400, footprint: [at(0.2, 0.2), at(0.201, 0.2), at(0.201, 0.201)] });
    geo.buildings.push({ id: 'small', heightDm: 60, footprint: [at(0.3, 0.3), at(0.3005, 0.3), at(0.3005, 0.3005)] });
    geo.pois.push({ id: 'p', name: 'x', cat: 'cafe', at: at(0.5, 0.5) });
    const filtered = filterForOverview(geo);
    expect(filtered.roads.map((r) => r.id)).toEqual(['a']);
    expect(filtered.buildings.map((b) => b.id)).toEqual(['tall']);
    expect(filtered.pois).toEqual([]);
  });
});

describe('isSyntheticEdge', () => {
  it('only fires when both ends are on the same side of the clip square', () => {
    expect(isSyntheticEdge([-256, 10], [-256, 900], 8192, 256)).toBe(true);
    expect(isSyntheticEdge([10, 8448], [900, 8448], 8192, 256)).toBe(true);
    // A corner cut: two edges, each on one side — both synthetic.
    expect(isSyntheticEdge([-256, -256], [-256, 400], 8192, 256)).toBe(true);
    // A real bank that merely touches the boundary at one end is not synthetic.
    expect(isSyntheticEdge([-256, 10], [400, 900], 8192, 256)).toBe(false);
  });

  it('covers every layer name the spec fixes', () => {
    expect([...LAYER_NAMES]).toEqual(['roads', 'buildings', 'water', 'parks', 'pois', 'stations', 'districts']);
  });
});
