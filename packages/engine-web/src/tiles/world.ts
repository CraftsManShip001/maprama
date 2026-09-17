/**
 * A streamed tile world: the archive, the render anchor, the streamer and the
 * assembled {@link WorldModel}, kept in step with the camera.
 *
 * ## The render anchor, and why re-basing is invisible
 *
 * World units are Mercator units scaled to metres at the world's reference
 * latitude (`mercator.ts`), offset by a **render anchor**. The anchor is the
 * geographic position of world `{ x: 0, z: 0 }`, and it follows the camera:
 * whenever the camera gets further than {@link REBASE_METERS} from it, the
 * anchor jumps to the camera and everything in the world is shifted by the
 * opposite amount — timed, where it can be, to coincide with a tile change so
 * that the two share one rebuild instead of paying for two.
 *
 * The anchor exists because **the vertex buffers the renderers bake are
 * `Float32Array`**. A float32 near magnitude *m* resolves to `m · 2⁻²³`, so a
 * building 400 km from the origin sits on a 3 cm grid; with the anchor never
 * further than a few kilometres the same grid is under a millimetre.
 *
 * What that is actually worth was measured rather than assumed
 * (`scripts/tile-shots.mjs --only precision`, and the table in
 * `docs/guide/tile-worlds.md`): identical content rendered at growing distances
 * from a pinned anchor starts to differ from the reference frame at about 8 km
 * and saturates near 45 of 255 on edge pixels. **It was not visible to the eye,
 * and no z-fighting appeared at any distance tested, up to 931 km** — the
 * engine's default camera limits stop at 1,200 m, where a 0.1 m displacement is
 * under a pixel. So the honest case for the anchor is not "the map falls apart
 * without it" but that it keeps the numbers small enough for the degradation to
 * be zero rather than merely small, keeps the world's `bounds` and its ground
 * plane sane, and is what a float32 CPU path (engine-native) will need.
 *
 * A re-base is a **pure translation**: the frame's scale is fixed when the world
 * is created and never changes, so `newCoord = oldCoord + delta` holds for
 * every coordinate without exception. If the camera, the geometry, the
 * characters, the markers, the labels and the info cards all take the same
 * delta in the same frame, the image does not change — that is not an
 * aspiration, it is arithmetic. The engine applies the delta inside one
 * `frame()` call, and `scripts/tile-shots.mjs` moves the anchor with the scene
 * otherwise untouched and compares the frames on either side. What it measures,
 * on the fixture world: **no pixel differs by more than 2 of 255**, which is
 * the float32 re-rounding of vertices that now sit at different numbers, not
 * anything moving. (With the shadow pass on, the shadow map is re-sampled on
 * its own world-space texel grid and the difference rises to ~30 of 255 — the
 * same artefact any sub-texel pan produces.)
 *
 * @module
 */

import type { LngLat, TileWorldSource } from '@maprama/protocol';
import { openArchive, type PMTilesFactory, type TileArchive } from './archive.js';
import { assembleTileWorld } from './assemble.js';
import { TileFrame } from './mercator.js';
import { DEFAULT_TILE_BUDGET, EDGE_HALO_METERS, TileStreamer, type Coverage } from './streamer.js';
import type { WorldModel } from '../world/model.js';

/**
 * How far the camera may drift from the render anchor before the anchor moves,
 * in metres.
 *
 * Chosen from the float32 vertex grid rather than from taste: the assembled
 * world reaches roughly `REBASE_METERS + the loaded ring` from the origin, and
 * at 8 km that grid is `8000 / 2²³ ≈ 0.95 mm` — two orders of magnitude below
 * anything a pixel can show at the closest camera distance. `tile-format.md`
 * suggested 20 km; 20 km would give 2.4 mm, which is also fine, but the cost of
 * a smaller threshold is only how often the world is re-assembled, and it is
 * re-assembled on every tile change anyway.
 */
export const REBASE_METERS = 5000;

/**
 * Multiple of {@link REBASE_METERS} at which a re-base stops waiting for a tile
 * change to share the rebuild with and simply happens.
 */
const HARD_REBASE_FACTOR = 2;

/** Metres per world unit of a tile world (the engine's usual 8 m per unit). */
export const TILE_UNIT_METERS = 8;

/**
 * Buildings kept per **overview** tile. The detail level has no budget.
 *
 * An overview tile covers 16× the ground of a detail tile, and the camera that
 * asks for one is kilometres out — a z13 Seoul view is 6 tiles and **7,641
 * buildings**, every one of them individually extruded, facaded, roofed and
 * shadow-cast. Measured on headless software GL that is ~13 s per frame with
 * `urban` and ~3 s with `realistic`, for a picture in which most of those
 * buildings are a few pixels of roof.
 *
 * So the overview keeps the buildings that carry the picture and drops the
 * rest, ranked by {@link overviewScore}. 200 per tile is where the measured
 * frame time comes back into the same range as a detail view (see
 * `scripts/nationwide-shots.mjs --only overview`) while Seoul still reads as
 * Seoul: the river, the arterials, the towers and the large blocks are all
 * above the line, and what goes is the low-rise infill that at this distance is
 * a texture rather than a building.
 *
 * It is a **per-tile** budget on purpose: a tile's contribution must not depend
 * on which neighbours are loaded, or buildings would pop in and out as the
 * camera pans, and the renderer could not reuse a tile's meshes.
 */
export const OVERVIEW_BUILDINGS_PER_TILE = 200;

export interface TileWorldDeps {
  /** Replaced in tests. */
  pmtiles?: PMTilesFactory;
  /** Called when the assembled world changed and the engine must rebuild. */
  onChange: () => void;
  /** Non-fatal problems (a tile that would not load). */
  onWarning?: (message: string) => void;
}

/** What a {@link TileWorld.step} produced. */
export interface TileStep {
  /** True when {@link TileWorld.world} is a new object and the engine must rebuild. */
  changed: boolean;
  /**
   * World-unit shift every existing world coordinate must take, `null` when the
   * anchor did not move. Applied in the same frame as `changed`.
   */
  rebase: { dx: number; dz: number } | null;
  /** True while tiles are in flight (the engine holds a render source for it). */
  loading: boolean;
}

/**
 * The part of a tile world the scene API hands out: diagnostics, and the one
 * knob a harness needs. Deliberately tiny — the streaming itself is the
 * engine's business.
 */
export interface TileWorldHandle {
  /**
   * How far the camera may drift from the render anchor before the anchor
   * moves, in metres. Defaults to {@link REBASE_METERS}.
   *
   * Writable so a test can make a re-base happen on demand and compare the
   * frames on either side of it, which is the only way to check the claim that
   * a re-base is invisible *without* also changing the tile set. Lowering it in
   * an app only makes the world re-assemble more often.
   */
  rebaseMeters: number;
  /** Tiles held, empty tiles, requests in flight, failures, level, anchor. */
  stats(): { loaded: number; empty: number; inflight: number; failed: number; zoom: number; anchor: LngLat };
}

export class TileWorld implements TileWorldHandle {
  /** See {@link TileWorldHandle.rebaseMeters}. */
  rebaseMeters = REBASE_METERS;
  private model: WorldModel;
  private lastZoom: number;

  private constructor(
    readonly source: TileWorldSource,
    readonly archive: TileArchive,
    readonly frame: TileFrame,
    private readonly streamer: TileStreamer,
  ) {
    this.model = this.assemble();
    this.lastZoom = streamer.zoom;
  }

  /**
   * Opens the archive and builds an empty world at `source.center`. Tiles start
   * arriving on the first {@link step}; until then the map shows ground, which
   * is the correct answer for "the data has not arrived yet" and for "there is
   * no data here".
   */
  static async open(source: TileWorldSource, deps: TileWorldDeps): Promise<TileWorld> {
    const archive = await openArchive(source.url, deps.pmtiles);
    const detailZoom = clampZoom(source.detailZoom ?? archive.maxZoom, archive);
    const overviewZoom = clampZoom(source.overviewZoom ?? archive.minZoom, archive);
    const frame = new TileFrame(source.center, source.center.lat, TILE_UNIT_METERS);
    const streamer = new TileStreamer(archive, {
      detailZoom,
      overviewZoom: Math.min(overviewZoom, detailZoom),
      budget: source.tileBudget ?? DEFAULT_TILE_BUDGET,
      onChange: deps.onChange,
      onError: deps.onWarning,
    });
    return new TileWorld(source, archive, frame, streamer);
  }

  /** The world as it currently stands. Replaced (not mutated) whenever it changes. */
  get world(): WorldModel {
    return this.model;
  }

  /** Diagnostics for the dev playground and the measurement scripts. */
  stats(): { loaded: number; empty: number; inflight: number; failed: number; zoom: number; anchor: LngLat } {
    return { ...this.streamer.stats(), anchor: this.frame.anchor };
  }

  /**
   * Brings the world in line with the camera.
   *
   * `corners` are the ground corners of the visible area in world units (what
   * `CameraController.groundCorners` returns); `centre` is the camera anchor.
   * Both are in the **current** frame, i.e. before any re-base this call makes.
   */
  step(centre: { x: number; z: number }, corners: readonly { x: number; z: number }[]): TileStep {
    // Tile addresses are geographic, so the streamer runs first, in the frame
    // the caller handed its corners in. Nothing it does depends on the anchor.
    const result = this.streamer.step(this.coverageFor(corners));
    const driftMeters = Math.hypot(centre.x, centre.z) * this.frame.unitMeters;

    // Re-basing costs one full re-assemble of the world, and so does a tile
    // change — so a re-base that *waits for* a tile change costs nothing at all.
    // The camera cannot drift `rebaseMeters` without crossing tile boundaries on
    // the way (a z15 tile is under a kilometre), so in practice the wait is
    // short; `HARD_REBASE_FACTOR` is the safety net for the case that it is not,
    // such as a camera teleported by `setCamera` into an empty region.
    const wants = driftMeters > this.rebaseMeters;
    const rebase = wants && (result.changed || driftMeters > this.rebaseMeters * HARD_REBASE_FACTOR)
      ? this.frame.rebase(this.frame.toLngLat(centre))
      : null;

    const changed = result.changed || rebase !== null || result.zoom !== this.lastZoom;
    this.lastZoom = result.zoom;
    if (changed) this.model = this.assemble(rebase ? { x: 0, z: 0 } : this.model.start);
    return { changed, rebase, loading: result.loading };
  }

  dispose(): void {
    this.streamer.dispose();
  }

  /** The geographic box to keep loaded: the visible ground plus the anchor-owned halo. */
  private coverageFor(corners: readonly { x: number; z: number }[]): Coverage {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const c of corners) {
      if (c.x < minX) minX = c.x;
      if (c.x > maxX) maxX = c.x;
      if (c.z < minZ) minZ = c.z;
      if (c.z > maxZ) maxZ = c.z;
    }
    if (!Number.isFinite(minX)) {
      minX = -1;
      minZ = -1;
      maxX = 1;
      maxZ = 1;
    }
    // The halo is why a building whose anchor is just off screen still shows up
    // (tile-format.md §3.1): it is added in *ground* metres, converted with the
    // frame's own scale.
    const halo = EDGE_HALO_METERS / this.frame.unitMeters;
    const nw = this.frame.toLngLat({ x: minX - halo, z: minZ - halo });
    const se = this.frame.toLngLat({ x: maxX + halo, z: maxZ + halo });
    return { west: nw.lng, north: nw.lat, east: se.lng, south: se.lat };
  }

  private assemble(start?: { x: number; z: number }): WorldModel {
    return assembleTileWorld(this.streamer.entries(), {
      frame: this.frame,
      attribution: this.streamer.attribution(),
      name: this.archive.metadata.name ?? 'Tiles',
      ...(this.streamer.isOverview ? { buildingsPerTile: OVERVIEW_BUILDINGS_PER_TILE } : {}),
      ...(start ? { start } : {}),
    });
  }
}

function clampZoom(z: number, archive: TileArchive): number {
  return Math.max(archive.minZoom, Math.min(archive.maxZoom, Math.round(z)));
}
