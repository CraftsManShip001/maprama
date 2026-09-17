/**
 * Where each layer's data comes from — the one place the pipeline decides that.
 *
 * Today every layer comes from OpenStreetMap. The Korean national building
 * dataset (GIS건물통합정보, CC BY / 공공누리 제1유형) is expected to replace or
 * reinforce `buildings`, and the point of this module is that doing so is a
 * change to {@link LayerRouting} plus one new {@link TileSource} — not a change
 * to the tiler, the encoder, the archive writer or the driver, none of which
 * know what a source is beyond its id.
 *
 * Two things follow from routing being per layer:
 *
 * - **Attribution is derived, not hardcoded.** The archive's `attribution`
 *   string table is the concatenation of the registered sources' lines, and each
 *   tile stores the indices of the sources that actually put something in it
 *   (§4.2). A tile with national buildings and a tile without get different
 *   index arrays for free.
 * - **Licences stay separable.** ODbL applies to what OSM supplied; a CC BY
 *   layer carries its own line. Mixing them is a data-licence question the table
 *   keeps answerable per tile.
 *
 * @module
 */

import { emptyBundle, LAYER_NAMES, type GeoBundle, type LayerName } from './types.js';
import type { GeoBounds } from './mercator.js';

/** One unit of work: a chunk of the country, with the margin its features need. */
export interface Region {
  /** Stable id, used for checkpoint filenames. */
  id: string;
  /** The area this region owns. Tiles outside it belong to a neighbour. */
  core: GeoBounds;
  /**
   * `core` grown by the margin a source must read to make the core complete —
   * far enough out that a building anchored just inside `core` has its whole
   * footprint, and that a road or river reaching in is not cut short.
   */
  padded: GeoBounds;
}

/** A provider of geographic features for a region. */
export interface TileSource {
  /** Stable id used by {@link LayerRouting} and in checkpoints. */
  readonly id: string;
  /** Attribution lines this source obliges us to display. */
  readonly attribution: readonly string[];
  /** Layers this source is able to supply. */
  readonly provides: readonly LayerName[];
  /**
   * Optional batch hook, called once with every region of a batch before any
   * {@link TileSource.load}. The OSM source uses it to read the national `.pbf`
   * **once** for the whole batch instead of once per region.
   */
  prepare?(regions: readonly Region[]): Promise<void>;
  /** Features for one region, covering `region.padded`. */
  load(region: Region): Promise<GeoBundle>;
  /** Drops whatever {@link TileSource.prepare} cached. */
  release?(): void;
}

/** Which source id supplies each layer. */
export type LayerRouting = Readonly<Record<LayerName, string>>;

/** Everything from OpenStreetMap — today's national build. */
export const DEFAULT_LAYER_ROUTING: LayerRouting = {
  roads: 'osm',
  buildings: 'osm',
  water: 'osm',
  parks: 'osm',
  pois: 'osm',
  stations: 'osm',
  districts: 'osm',
};

/** Fails early when a routing names a source that is not registered, or that cannot supply the layer. */
export function validateRouting(sources: readonly TileSource[], routing: LayerRouting): void {
  const byId = new Map(sources.map((s) => [s.id, s]));
  for (const layer of LAYER_NAMES) {
    const id = routing[layer];
    const source = byId.get(id);
    if (!source) throw new Error(`layer "${layer}" is routed to unknown source "${id}"`);
    if (!source.provides.includes(layer)) throw new Error(`source "${id}" does not provide layer "${layer}"`);
  }
}

/** The source ids a routing actually uses, in registration order. */
export function activeSources(sources: readonly TileSource[], routing: LayerRouting): TileSource[] {
  const used = new Set(LAYER_NAMES.map((layer) => routing[layer]));
  return sources.filter((s) => used.has(s.id));
}

/**
 * The archive metadata's `attribution` string table: every active source's lines
 * in registration order, first occurrence wins.
 */
export function attributionTable(sources: readonly TileSource[], routing: LayerRouting): string[] {
  const table: string[] = [];
  for (const source of activeSources(sources, routing)) {
    for (const line of source.attribution) if (!table.includes(line)) table.push(line);
  }
  return table;
}

/** Source id -> its indices into {@link attributionTable}, ascending. */
export function attributionIndices(
  sources: readonly TileSource[],
  routing: LayerRouting,
): Map<string, number[]> {
  const table = attributionTable(sources, routing);
  const out = new Map<string, number[]>();
  for (const source of activeSources(sources, routing)) {
    const indices = source.attribution.map((line) => table.indexOf(line)).filter((i) => i >= 0);
    out.set(source.id, [...new Set(indices)].sort((a, b) => a - b));
  }
  return out;
}

/** The attribution indices a tile stores, given the sources that contributed to it. */
export function tileAttribution(contributors: Iterable<string>, indices: ReadonlyMap<string, number[]>): number[] {
  const set = new Set<number>();
  for (const id of contributors) for (const i of indices.get(id) ?? []) set.add(i);
  return [...set].sort((a, b) => a - b);
}

/**
 * Loads one region from every source the routing uses and keeps, from each, only
 * the layers routed to it.
 *
 * A source is asked once per region even when it supplies several layers, so a
 * source that builds all seven layers from one input (the OSM one does) pays for
 * that input once.
 */
export async function composeRegion(
  sources: readonly TileSource[],
  routing: LayerRouting,
  region: Region,
): Promise<GeoBundle> {
  const out = emptyBundle();
  for (const source of activeSources(sources, routing)) {
    const layers = LAYER_NAMES.filter((layer) => routing[layer] === source.id);
    if (layers.length === 0) continue;
    const bundle = await source.load(region);
    for (const layer of layers) (out[layer] as unknown[]) = bundle[layer];
  }
  return out;
}
