/**
 * The tile streamer: what to load for the camera that is on screen, what to
 * throw away, and when to move the render anchor.
 *
 * Three rules it exists to enforce, all of them from `design/tile-format.md`:
 *
 * 1. **Load a ring beyond what is visible.** Buildings are *anchor-owned*: the
 *    tile that contains a building's footprint anchor holds the whole building,
 *    uncut, so a building can stick up to 45.9 m (measured) out of its tile.
 *    Culling to exactly the visible tiles would drop the building whose anchor
 *    is just off screen but whose wall is on it. The halo is
 *    {@link EDGE_HALO_METERS}, the spec's 128 m.
 * 2. **Keep a budget.** Tiles are evicted least-recently-*needed* first, so
 *    panning back and forth across a boundary does not re-download.
 * 3. **A missing tile is ground, not an error.** South Korea is mostly
 *    mountain and empty tiles are not stored at all; `null` is cached like any
 *    other answer so the same hole is not asked for twice.
 *
 * The streamer never touches three.js, the camera or the clock: it is given a
 * viewport rectangle and told to step, and it reports whether the set of loaded
 * tiles changed. That is what makes it testable without a renderer, and what
 * keeps network waiting out of the render loop.
 *
 * @module
 */

import { decodeTile, resolveTileAttribution, type MtilTile } from '@maprama/protocol';
import type { TileArchive } from './archive.js';
import { tileKey, tileOf, type TileId } from './mercator.js';

/**
 * Extra ground kept loaded beyond the visible rectangle, in metres.
 *
 * `tile-format.md` §3.1: the largest measured overhang of an anchor-owned
 * building is 45.9 m (Seongsu) and the spec asks for at least 128 m of slack.
 */
export const EDGE_HALO_METERS = 128;

/** Default cap on tiles held in memory. Overridable per world (`tileBudget`). */
export const DEFAULT_TILE_BUDGET = 96;

/**
 * Tiles of slack kept around the viewport rectangle before a tile is dropped
 * outright. Small pans and short flights back do not re-download; a tile that
 * is further away than this is gone regardless of the budget.
 */
const KEEP_RING = 2;

/** How many tiles a level may need before the streamer drops to the overview level. */
const ZOOM_FIT_FRACTION = 0.5;

/** A geographic rectangle to cover, plus the level choice that goes with it. */
export interface Coverage {
  west: number;
  south: number;
  east: number;
  north: number;
}

interface Entry {
  key: string;
  id: TileId;
  /** `null` once loaded and the archive had nothing there. */
  tile: MtilTile | null;
  /** Monotonic counter: the last step at which this tile was wanted. */
  touched: number;
}

/** What one {@link TileStreamer.step} did. */
export interface StepResult {
  /** True when the set of loaded tiles changed, so the world must be re-assembled. */
  changed: boolean;
  /** True while at least one request is in flight. */
  loading: boolean;
  /** The level the streamer is currently covering with. */
  zoom: number;
}

export class TileStreamer {
  private readonly loaded = new Map<string, Entry>();
  private readonly inflight = new Map<string, TileId>();
  private readonly failed = new Map<string, number>();
  private clock = 0;
  private dirty = false;
  private currentZoom: number;
  private disposed = false;

  constructor(
    private readonly archive: TileArchive,
    private readonly opts: {
      detailZoom: number;
      overviewZoom: number;
      budget: number;
      /** Called when a tile arrives, so the engine can ask for a frame. */
      onChange: () => void;
      /** Called when a tile request fails; the streamer keeps going. */
      onError?: (message: string) => void;
    },
  ) {
    this.currentZoom = opts.detailZoom;
  }

  /** Tiles currently held, in a stable order (row-major) so the assembled world is deterministic. */
  entries(): { z: number; x: number; y: number; tile: MtilTile | null }[] {
    const out = [...this.loaded.values()].map((e) => ({ z: e.id.z, x: e.id.x, y: e.id.y, tile: e.tile }));
    out.sort((a, b) => a.z - b.z || a.y - b.y || a.x - b.x);
    return out;
  }

  /** Attribution lines of everything currently loaded, in the archive's table order. */
  attribution(): string[] {
    const wanted = new Set<number>();
    for (const e of this.loaded.values()) if (e.tile) for (const i of e.tile.attribution) wanted.add(i);
    // An archive whose tiles carry no indices still has to be credited: fall
    // back to the whole table rather than showing nothing. Attribution is a
    // licence obligation, so the failure mode has to be "too much", not "none".
    const indices = wanted.size > 0 ? [...wanted].sort((a, b) => a - b) : this.archive.attribution.map((_, i) => i);
    return resolveTileAttribution(indices, this.archive.attribution);
  }

  /** True while at least one request is in flight. */
  get loading(): boolean {
    return this.inflight.size > 0;
  }

  /** The level being covered right now. */
  get zoom(): number {
    return this.currentZoom;
  }

  /**
   * True while the streamer is covering with the **overview** level — the state
   * in which the camera is far enough out that a per-tile feature budget
   * applies (`OVERVIEW_BUILDINGS_PER_TILE`). False for an archive whose two
   * levels coincide, where there is no "pulled back" state to distinguish.
   */
  get isOverview(): boolean {
    return this.opts.overviewZoom < this.opts.detailZoom && this.currentZoom === this.opts.overviewZoom;
  }

  /**
   * Chooses a level for a viewport `spanMeters` wide, and returns the tiles
   * needed to cover `coverage` at it.
   *
   * The detail level is used while it fits the budget; beyond that the overview
   * level takes over, which is the same moment the camera has pulled back far
   * enough that z15 detail would not be legible anyway. The two levels never
   * mix: one set of tiles, one world, no seam between resolutions.
   */
  private chooseZoom(coverage: Coverage): number {
    const detail = this.opts.detailZoom;
    const overview = this.opts.overviewZoom;
    if (overview >= detail) return detail;
    const budget = Math.max(4, Math.floor(this.opts.budget * ZOOM_FIT_FRACTION));
    // The budget alone is not a safe hand-over point, because it counts tiles
    // and what costs is what is *in* them. Measured on the nationwide archive
    // (Gangnam, camera pulled out to 7.2 km): the budget rule kept the detail
    // level until 45 z15 tiles were wanted, which assemble into a world of
    // 17,906 buildings and 25,957 road edges — one synchronous re-assemble and
    // renderer rebuild that blocked the main thread for ~29 s on headless
    // software GL. The same view at the overview level is 6 tiles, 7,641
    // buildings, and a few seconds.
    //
    // So the hand-over is capped by geometry as well: once the detail level
    // needs more ground than a single overview tile covers, the overview level
    // is by definition the right resolution for what is on screen, and it is
    // also the last point at which one re-assemble is still affordable.
    const perOverviewTile = 4 ** (detail - overview);
    return tilesNeeded(coverage, detail) <= Math.min(budget, perOverviewTile) ? detail : overview;
  }

  /**
   * Brings the loaded set in line with `coverage`, starting requests for what is
   * missing and evicting the least-recently-wanted tiles over budget.
   */
  step(coverage: Coverage): StepResult {
    if (this.disposed) return { changed: false, loading: false, zoom: this.currentZoom };
    const z = this.chooseZoom(coverage);
    const now = ++this.clock;
    if (z !== this.currentZoom) {
      // A level change replaces the world wholesale; the eviction below drops
      // the other level's tiles, since none of them is at `z`.
      this.currentZoom = z;
      this.dirty = true;
    }
    const want = tileRange(coverage, z);
    let wanted = 0;
    for (let y = want.y0; y <= want.y1; y++) {
      for (let x = want.x0; x <= want.x1; x++) {
        wanted++;
        const key = tileKey(z, x, y);
        const have = this.loaded.get(key);
        if (have) {
          have.touched = now;
          continue;
        }
        if (this.inflight.has(key) || this.failed.has(key)) continue;
        this.request({ z, x, y }, now);
      }
    }
    // Two evictions, and both are needed.
    //
    // Distance first: a tile far outside the viewport must go even when the
    // budget is nowhere near full. It is not just memory — the assembled world
    // is one coordinate frame, so a tile left over from a city 300 km away
    // would stretch the world's bounds (and its `Float32Array` geometry) across
    // the whole country, which is precisely what the render anchor exists to
    // prevent. `KEEP_RING` tiles of slack keep a small pan from re-downloading.
    for (const [key, e] of this.loaded) {
      if (e.id.z !== z || e.id.x < want.x0 - KEEP_RING || e.id.x > want.x1 + KEEP_RING || e.id.y < want.y0 - KEEP_RING || e.id.y > want.y1 + KEEP_RING) {
        this.loaded.delete(key);
        this.dirty = true;
      }
    }
    // Then the budget, least-recently-wanted first. Never below what the
    // viewport itself needs, or a pan would thrash.
    this.evict(Math.max(this.opts.budget, wanted));
    const changed = this.dirty;
    this.dirty = false;
    return { changed, loading: this.inflight.size > 0, zoom: z };
  }

  private request(id: TileId, now: number): void {
    const key = tileKey(id.z, id.x, id.y);
    this.inflight.set(key, id);
    void this.archive
      .getTile(id.z, id.x, id.y)
      .then((bytes) => {
        if (this.disposed) return;
        // `null` (no tile in the archive) is cached exactly like a tile: an
        // empty region must not be asked for again on every frame.
        const tile = bytes === null ? null : decodeTile(bytes);
        this.loaded.set(key, { key, id, tile, touched: now });
        this.dirty = true;
      })
      .catch((e: unknown) => {
        // One bad tile must not take the map down. Remember the failure so the
        // request is not retried every frame, and say so once.
        this.failed.set(key, now);
        this.opts.onError?.(`tile ${key}: ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        this.inflight.delete(key);
        if (!this.disposed) this.opts.onChange();
      });
  }

  private evict(limit: number): void {
    if (this.loaded.size <= limit) return;
    const byAge = [...this.loaded.values()].sort((a, b) => a.touched - b.touched);
    for (let i = 0; i < byAge.length - limit; i++) {
      this.loaded.delete(byAge[i]!.key);
      this.dirty = true;
    }
  }

  /** Diagnostics: how many tiles are held, how many are empty, how many failed. */
  stats(): { loaded: number; empty: number; inflight: number; failed: number; zoom: number } {
    let empty = 0;
    for (const e of this.loaded.values()) if (!e.tile) empty++;
    return { loaded: this.loaded.size, empty, inflight: this.inflight.size, failed: this.failed.size, zoom: this.currentZoom };
  }

  dispose(): void {
    this.disposed = true;
    this.loaded.clear();
    this.inflight.clear();
    this.failed.clear();
  }
}

/** The inclusive tile rectangle covering a geographic box at `z`. */
export function tileRange(c: Coverage, z: number): { x0: number; x1: number; y0: number; y1: number } {
  const nw = tileOf(c.west, c.north, z);
  const se = tileOf(c.east, c.south, z);
  return { x0: Math.min(nw.x, se.x), x1: Math.max(nw.x, se.x), y0: Math.min(nw.y, se.y), y1: Math.max(nw.y, se.y) };
}

/** How many tiles `coverage` needs at `z`. */
export function tilesNeeded(c: Coverage, z: number): number {
  const r = tileRange(c, z);
  return (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
}
