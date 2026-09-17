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
 * opposite amount.
 *
 * The anchor exists for one reason: **the vertex buffers the renderers bake are
 * `Float32Array`**. A float32 near magnitude *m* resolves to `m · 2⁻²³`, so a
 * building 400 km from the origin would be quantised to a 3 cm grid — its
 * corners visibly shimmer as the camera moves, and coplanar surfaces z-fight.
 * With the anchor never further than a few kilometres, the same quantisation is
 * well under a millimetre. (See `docs/guide/tile-worlds.md` for the measured
 * numbers.)
 *
 * A re-base is a **pure translation**: the frame's scale is fixed when the world
 * is created and never changes, so `newCoord = oldCoord + delta` holds for
 * every coordinate without exception. If the camera, the geometry, the
 * characters, the markers, the labels and the info cards all take the same
 * delta in the same frame, the image is identical — that is not an aspiration,
 * it is arithmetic. The engine applies the delta inside one `frame()` call, and
 * `scripts/tile-rebase.mjs` proves the before/after frames are byte-identical.
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

/** Metres per world unit of a tile world (the engine's usual 8 m per unit). */
export const TILE_UNIT_METERS = 8;

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

export class TileWorld {
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
    let rebase: { dx: number; dz: number } | null = null;
    const driftUnits = Math.hypot(centre.x, centre.z);
    if (driftUnits * this.frame.unitMeters > REBASE_METERS) {
      const next = this.frame.toLngLat(centre);
      const d = this.frame.rebase(next);
      rebase = d;
    }
    // Coverage is computed *after* the re-base, in the new frame, so the tile
    // set and the world are always consistent with the anchor they were built
    // for. The corners move with everything else.
    const shifted = corners.map((c) => ({ x: c.x + (rebase?.dx ?? 0), z: c.z + (rebase?.dz ?? 0) }));
    const result = this.streamer.step(this.coverageFor(shifted));
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
      ...(start ? { start } : {}),
    });
  }
}

function clampZoom(z: number, archive: TileArchive): number {
  return Math.max(archive.minZoom, Math.min(archive.maxZoom, Math.round(z)));
}
