/**
 * How the country is cut into units of work.
 *
 * A chunk is one slippy tile at a low zoom (default z10, ~31 km square). That
 * choice is not cosmetic — it buys three properties the driver depends on:
 *
 * 1. **Exact tile ownership.** Every z13 and z15 tile nests inside exactly one
 *    chunk, so "this chunk owns these tiles" is integer arithmetic with no
 *    boundary case, and no tile is ever produced twice.
 * 2. **Sorted output for free.** PMTiles orders tiles along a Hilbert curve, and
 *    the curve is recursive: the descendants of one chunk occupy a *contiguous*
 *    id range. Visiting chunks in id order therefore emits tiles in archive
 *    order, which is what lets the archive be assembled by streaming.
 * 3. **A bounded memory unit.** The extractor's cost scales with the area asked
 *    for at once; the chunk is the knob that bounds it.
 *
 * @module
 */

import { tileBounds, type GeoBounds } from './mercator.js';
import { zxyToTileId } from './pmtiles.js';
import type { Region } from './sources.js';

/**
 * Geographic margin, in degrees, added around a chunk before its data is read.
 *
 * It has to cover the worst case of a feature that a *core* tile owns but whose
 * geometry reaches outside the chunk: an anchor-owned building sitting against
 * the chunk edge extends by up to half its own size, and the spike measured
 * 45.9 m of tile overhang in Seongsu with a 203 m building as the largest input.
 * Airport terminals and stadiums are bigger and were never measured, so this is
 * deliberately generous — 0.01° is about 1.1 km at Korean latitudes — and the
 * cost is only that the padded area is ~6 % larger than the chunk.
 */
export const DEFAULT_PAD_DEG = 0.01;

/** A chunk of the national grid. */
export interface Chunk extends Region {
  /** Chunk zoom. */
  cz: number;
  /** Chunk address. */
  cx: number;
  cy: number;
  /** PMTiles id of the chunk tile — the visiting order. */
  tileId: number;
  /** Nodes the survey found inside the chunk; the batching budget's unit. */
  nodes: number;
}

/** Inclusive tile window a chunk owns at `z`. */
export function windowFor(chunk: { cz: number; cx: number; cy: number }, z: number): {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
} {
  if (z < chunk.cz) throw new RangeError(`windowFor: zoom ${z} is coarser than the chunk zoom ${chunk.cz}`);
  const k = 2 ** (z - chunk.cz);
  return { x0: chunk.cx * k, x1: chunk.cx * k + k - 1, y0: chunk.cy * k, y1: chunk.cy * k + k - 1 };
}

/** Grows a box by `pad` degrees, clamped to the Web Mercator latitude limit. */
export function padBounds(b: GeoBounds, pad: number): GeoBounds {
  return {
    west: Math.max(-180, b.west - pad),
    east: Math.min(180, b.east + pad),
    south: Math.max(-85.05112878, b.south - pad),
    north: Math.min(85.05112878, b.north + pad),
  };
}

/** Options for {@link planChunks}. */
export interface PlanChunksOptions {
  /** Chunk zoom. Default 10. */
  chunkZoom?: number;
  /** Area to cover. */
  bounds: GeoBounds;
  /** Node counts per chunk cell, keyed `"<x>/<y>"`, from `surveyPbfNodes`. */
  survey: ReadonlyMap<string, number>;
  /** Chunks with fewer nodes than this are skipped entirely. Default 1. */
  minNodes?: number;
  /** Margin around each chunk. Default {@link DEFAULT_PAD_DEG}. */
  padDeg?: number;
}

/**
 * The chunks a build will visit, in PMTiles id order.
 *
 * Chunks the survey found empty are dropped here rather than discovered to be
 * empty later: over South Korea that is most of the grid (sea, and the ~60 % of
 * the land that is mountain), and skipping them is the difference between ~400
 * extractions and ~200.
 */
export function planChunks(options: PlanChunksOptions): Chunk[] {
  const cz = options.chunkZoom ?? 10;
  const minNodes = options.minNodes ?? 1;
  const pad = options.padDeg ?? DEFAULT_PAD_DEG;
  const n = 2 ** cz;
  const clamp = (v: number): number => (v < 0 ? 0 : v > n - 1 ? n - 1 : v);
  const merc = (lat: number): number => {
    const s = Math.sin((lat * Math.PI) / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  };
  const b = options.bounds;
  const x0 = clamp(Math.floor(((b.west + 180) / 360) * n));
  const x1 = clamp(Math.floor(((b.east + 180) / 360) * n));
  const y0 = clamp(Math.floor(merc(b.north) * n));
  const y1 = clamp(Math.floor(merc(b.south) * n));

  const chunks: Chunk[] = [];
  for (let cx = x0; cx <= x1; cx++) {
    for (let cy = y0; cy <= y1; cy++) {
      const nodes = options.survey.get(`${cx}/${cy}`) ?? 0;
      if (nodes < minNodes) continue;
      const core = tileBounds(cz, cx, cy);
      chunks.push({
        id: `${cz}-${cx}-${cy}`,
        cz,
        cx,
        cy,
        core,
        padded: padBounds(core, pad),
        tileId: zxyToTileId(cz, cx, cy),
        nodes,
      });
    }
  }
  chunks.sort((a, c) => a.tileId - c.tileId);
  return chunks;
}

/**
 * Groups chunks into extraction batches.
 *
 * One `.pbf` scan costs ~35 s regardless of how many boxes it serves, so bigger
 * batches are strictly faster — until the extractor's node bookkeeping runs the
 * heap out. `nodeBudget` is the brake, in nodes per batch, and the survey's
 * per-chunk counts are what it is spent against. A single chunk over budget
 * still gets its own batch rather than being dropped.
 *
 * Batches keep chunks in id order, so archive order survives batching.
 */
export function batchChunks(chunks: readonly Chunk[], nodeBudget: number, maxPerBatch = 64): Chunk[][] {
  const batches: Chunk[][] = [];
  let current: Chunk[] = [];
  let sum = 0;
  for (const chunk of chunks) {
    if (current.length > 0 && (sum + chunk.nodes > nodeBudget || current.length >= maxPerBatch)) {
      batches.push(current);
      current = [];
      sum = 0;
    }
    current.push(chunk);
    sum += chunk.nodes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
