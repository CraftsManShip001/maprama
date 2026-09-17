/**
 * Reads an OSM PBF extract (for example a Geofabrik `.osm.pbf`) and produces
 * the **same raw payload shape** `buildWorld` already consumes — an Overpass
 * `[out:json]` + `out geom` response. Nothing here knows about `WorldData`:
 * this module is an adapter in front of the existing, unchanged builder, so a
 * world built from a PBF goes through exactly the same code as one built from
 * Overpass.
 *
 * Two things have to line up for the two paths to agree:
 *
 * 1. **The same features.** {@link selectsPbfElement} mirrors, statement for
 *    statement, the Overpass QL that {@link buildOverpassQuery} emits.
 * 2. **The same order.** Overpass `out geom` writes nodes, then ways, then
 *    relations, each ascending by id, and `buildWorld` resolves a few ties
 *    (duplicate footprints, station ids, the plaza) by first-seen. The elements
 *    emitted here are sorted the same way.
 *
 * Memory: a national extract is never held in memory. The file is read in
 * three streaming passes and only the ids and coordinates a bbox actually needs
 * are retained — see {@link extractFromPbf}.
 *
 * @module
 */

import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { inflateSync } from 'node:zlib';
import { OSMTransform, parse as parsePrimitiveBlock } from 'osm-pbf-parser-node';
import { assertBBox } from './build.js';
import { clipPolylineToRect, pointInRect, type Rect } from './geometry.js';
import type {
  BBox,
  OverpassElement,
  OverpassLatLon,
  OverpassNode,
  OverpassRelation,
  OverpassRelationMember,
  OverpassResponse,
  OverpassWay,
  Tags,
} from './types.js';

/** An element as the PBF parser yields it. */
interface PbfItem {
  type?: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  refs?: number[];
  members?: { type: 'node' | 'way' | 'relation'; ref: number; role: string }[];
  tags?: Tags;
}

/** `generator` value written into the raw payload, so a raw file says where it came from. */
export const PBF_GENERATOR = 'maprama-osm (osm.pbf)';

// ---------------------------------------------------------------------------
// Feature selection — the mirror of buildOverpassQuery()
// ---------------------------------------------------------------------------

/** `nwr["amenity"~"^(cafe|school|kindergarten)$"]` */
const AMENITY_POI = /^(cafe|school|kindergarten)$/;
/** `nwr["shop"~"^(convenience|supermarket|music|books)$"]` */
const SHOP_POI = /^(convenience|supermarket|music|books)$/;
/**
 * `nwr["shop"]["name"~"LP|레코드|음반"]` and the `amenity` twin. Overpass `~` is
 * case-sensitive and unanchored, and it tests the `name` tag (not `name:ko`).
 */
const MUSIC_NAME = /LP|레코드|음반/;
/** `["leisure"~"^(park|garden)$"]` */
const LEISURE_AREA = /^(park|garden)$/;
/** `["landuse"~"^(grass|recreation_ground)$"]` */
const LANDUSE_AREA = /^(grass|recreation_ground)$/;
/** `node["place"~"^(square|neighbourhood|quarter|suburb)$"]` */
const PLACE_NODE = /^(square|neighbourhood|quarter|suburb)$/;

/** The `way|relation` water selectors: `natural=water`, `waterway=riverbank`, `water=river`. */
function isWaterSelector(tags: Tags): boolean {
  return tags.natural === 'water' || tags.waterway === 'riverbank' || tags.water === 'river';
}

/** The four `nwr[...]` POI selectors, which apply to nodes, ways and relations alike. */
function isNwrPoi(tags: Tags): boolean {
  if (AMENITY_POI.test(tags.amenity ?? '')) return true;
  if (SHOP_POI.test(tags.shop ?? '')) return true;
  if (tags.shop === undefined && tags.amenity === undefined) return false;
  return MUSIC_NAME.test(tags.name ?? '');
}

/** The `["leisure"~...]` / `["landuse"~...]` green-area selectors. */
function isGreenSelector(tags: Tags): boolean {
  return LEISURE_AREA.test(tags.leisure ?? '') || LANDUSE_AREA.test(tags.landuse ?? '');
}

/**
 * True when an element with these tags is one the Overpass query would return.
 *
 * Kept deliberately literal so it can be diffed against
 * {@link buildOverpassQuery} line by line. Note that `way["building"]` matches
 * the *presence* of the tag, `building=no` included: `buildWorld` drops those
 * itself, and matching Overpass here keeps the two raw payloads identical.
 */
export function selectsPbfElement(type: 'node' | 'way' | 'relation', tags: Tags | undefined): boolean {
  if (!tags) return false;
  if (type === 'node') {
    // node["leisure"="park"], the nwr POIs, node["railway"="station"],
    // node["station"="subway"], node["place"~...]
    return (
      tags.leisure === 'park' ||
      isNwrPoi(tags) ||
      tags.railway === 'station' ||
      tags.station === 'subway' ||
      PLACE_NODE.test(tags.place ?? '')
    );
  }
  if (type === 'way') {
    // way["building"], way["highway"], water, green, nwr POIs, way["place"="square"]
    return (
      tags.building !== undefined ||
      tags.highway !== undefined ||
      isWaterSelector(tags) ||
      isGreenSelector(tags) ||
      isNwrPoi(tags) ||
      tags.place === 'square'
    );
  }
  // relation["building"]["type"="multipolygon"], water, green, nwr POIs
  return (
    (tags.building !== undefined && tags.type === 'multipolygon') ||
    isWaterSelector(tags) ||
    isGreenSelector(tags) ||
    isNwrPoi(tags)
  );
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/** Stop signal a scan callback may return to abort the rest of the file. */
const STOP = 'stop' as const;

interface ScanOptions {
  /** First data blob to inflate (0-based, counting only `OSMData` blobs). */
  fromBlob?: number;
  /** One past the last data blob to inflate; the scan ends there. */
  toBlob?: number;
  /** Called with the file's `OSMHeader` block. */
  onHeader?: (header: PbfHeader) => void;
}

/** The fields of the `OSMHeader` block this module reads. */
interface PbfHeader {
  writingprogram?: string;
  osmosis_replication_timestamp?: number;
}

/**
 * Streams a `.osm.pbf` and calls `onBatch` once per decoded block.
 *
 * Runs the parser in its raw mode, which hands over the still-compressed blobs,
 * so a pass that only cares about (say) the way section pays the file read but
 * not the inflate + protobuf decode for the node blocks, which are the bulk of
 * every extract. `onBatch` returning `'stop'`, or reaching `toBlob`, ends the
 * scan immediately.
 *
 * @returns the index of the first data blob that was *not* processed.
 */
async function scanPbf(
  file: string,
  onBatch: (items: PbfItem[], blob: number) => typeof STOP | void,
  options: ScanOptions = {},
): Promise<number> {
  const from = options.fromBlob ?? 0;
  const to = options.toBlob ?? Infinity;
  let blob = 0;
  let stopped = false;
  const source = createReadStream(file);
  const sink = new Writable({
    objectMode: true,
    write(chunk: Buffer | unknown[], _enc, next) {
      if (!Buffer.isBuffer(chunk)) {
        // the OSMHeader block, pushed as a one-element array
        if (Array.isArray(chunk) && chunk[0]) options.onHeader?.(chunk[0] as PbfHeader);
        return next();
      }
      const index = blob++;
      if (index < from) return next();
      if (index >= to) {
        stopped = true;
        source.destroy();
        return next();
      }
      const items = parsePrimitiveBlock(inflateSync(chunk), { withTags: true, withInfo: false }) as PbfItem[];
      if (onBatch(items, index) === STOP) {
        stopped = true;
        source.destroy();
      }
      next();
    },
  });
  try {
    await pipeline(source, new OSMTransform({ writeRaw: true }), sink);
  } catch (e) {
    // Destroying the source to stop early surfaces here as ERR_STREAM_PREMATURE_CLOSE.
    if (!stopped) throw e;
  }
  return blob;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * How far outside a bbox, in degrees, node coordinates are still tracked so
 * that a way *crossing* the box can be recognised.
 *
 * Overpass returns a way that intersects the bbox even when none of its
 * vertices is inside it, and that is not a corner case: a 280 m test box in
 * Seongsu-dong already contains one (성수일로12길, whose two nearest vertices sit
 * just outside opposite edges). Recognising it needs the coordinates of nodes
 * outside the box, so the reader tracks the ids of nodes within this margin and
 * tests the real geometry once it has it.
 *
 * 0.005° is ~550 m at Korean latitudes, comfortably longer than any ordinary
 * road or building edge. A single straight segment that both spans the bbox and
 * has each endpoint further than this outside it would still be missed.
 */
export const PBF_CROSSING_PAD_DEG = 0.005;

/** Options for {@link extractFromPbf}. */
export interface ExtractFromPbfOptions {
  /** Progress logger (the CLI passes its stderr writer). */
  log?: (message: string) => void;
  /** Override {@link PBF_CROSSING_PAD_DEG}. */
  crossingPadDeg?: number;
}

/** What one bbox collected, and what it cost. */
export interface PbfExtractStats {
  /** Elements in the emitted payload. */
  elements: number;
  nodes: number;
  ways: number;
  relations: number;
  /** Way/relation vertices whose node was not in the extract (emitted as `null`, as Overpass does). */
  missingNodes: number;
}

/** Result of {@link extractFromPbf}: one raw payload (and its stats) per requested bbox. */
export interface PbfExtractResult {
  bbox: BBox;
  raw: OverpassResponse;
  stats: PbfExtractStats;
}

/** Per-bbox state while scanning. */
interface Area {
  bbox: BBox;
  /** The bbox as a rectangle in lon/lat, for the geometry tests. */
  rect: Rect;
  /** The bbox grown by the crossing margin. */
  pad: BBox;
  /** Ids of nodes inside the bbox. */
  nodeIds: Set<number>;
  /** Ids of nodes inside the margin but outside the bbox. */
  ringNodeIds: Set<number>;
  /** Selected nodes, ready to emit. */
  nodes: OverpassNode[];
  /** Ids of *any* way reaching into the margin — tagged or not (relation members carry no tags). */
  nearWayIds: Set<number>;
  /** Ids of selected ways with a vertex inside the bbox. */
  selectedWays: Set<number>;
  /** Selected ways that only *may* cross the bbox; confirmed once their geometry is known. */
  crossingCandidates: Set<number>;
  /** Selected relations that reach into the margin; confirmed once their geometry is known. */
  candidateRelations: Set<number>;
  /** Ids of confirmed relations. */
  selectedRelations: Set<number>;
}

function inBBox(bbox: BBox, lat: number, lon: number): boolean {
  return lat >= bbox.south && lat <= bbox.north && lon >= bbox.west && lon <= bbox.east;
}

/**
 * Builds one Overpass-shaped raw payload per bbox from a single `.osm.pbf`.
 *
 * **One file scan serves every bbox**, which is the point of this entry point:
 * extracting N areas costs one read, not N. The CLI's `build --pbf` is the
 * single-bbox case.
 *
 * Three passes, because a way needs its nodes and a relation needs its member
 * ways, and a PBF stores nodes, then ways, then relations:
 *
 * 1. **Whole file.** Remember which node ids fall inside each bbox (plus the
 *    selected nodes themselves, which are few); which way ids touch each bbox;
 *    the node refs of the selected ways; and the members of the selected
 *    relations (a relation is kept when one of its members touches the bbox).
 * 2. **Way section.** Pick up the node refs of relation-member ways that pass 1
 *    did not already store — a multipolygon's member ways carry no tags, so
 *    pass 1 had no reason to keep them. Ends as soon as the last one is seen.
 * 3. **Node section.** Resolve the coordinates of every referenced node,
 *    including the ones outside the bbox: Overpass `out geom` returns a way's
 *    full geometry and `buildWorld` clips it, so dropping the outside vertices
 *    would move the clipped edge. Ends as soon as the last needed id is past.
 *
 * What is retained is therefore proportional to the requested bboxes (and to
 * the size of the relations that reach into them), never to the file.
 *
 * Ways and relations that merely *cross* the bbox are included, as Overpass
 * includes them, out to {@link PBF_CROSSING_PAD_DEG}.
 */
export async function extractFromPbf(
  file: string,
  bboxes: readonly BBox[],
  options: ExtractFromPbfOptions = {},
): Promise<PbfExtractResult[]> {
  if (bboxes.length === 0) throw new RangeError('extractFromPbf: at least one bbox is required');
  for (const b of bboxes) assertBBox(b);
  const log = options.log ?? ((): void => {});

  const pad = options.crossingPadDeg ?? PBF_CROSSING_PAD_DEG;
  if (!(pad >= 0)) throw new RangeError('crossingPadDeg must be >= 0');
  const areas: Area[] = bboxes.map((bbox) => ({
    bbox,
    rect: { minX: bbox.west, minZ: bbox.south, maxX: bbox.east, maxZ: bbox.north },
    pad: { south: bbox.south - pad, west: bbox.west - pad, north: bbox.north + pad, east: bbox.east + pad },
    nodeIds: new Set<number>(),
    ringNodeIds: new Set<number>(),
    nodes: [],
    nearWayIds: new Set<number>(),
    selectedWays: new Set<number>(),
    crossingCandidates: new Set<number>(),
    candidateRelations: new Set<number>(),
    selectedRelations: new Set<number>(),
  }));

  /** Node refs of every way we will need geometry for, shared across bboxes. */
  const wayRefs = new Map<number, number[]>();
  /** Tags of the selected ways, shared across bboxes. */
  const wayTags = new Map<number, Tags>();
  /** Selected relations, shared across bboxes. */
  const relations = new Map<number, { tags: Tags; members: OverpassRelationMember[] }>();

  let timestamp: string | undefined;
  let firstWayBlob = Infinity;

  // --- Pass 1: the whole file -----------------------------------------------
  const t0 = Date.now();
  const totalBlobs = await scanPbf(file, (items, blob) => {
    for (const el of items) {
      if (el.type === 'node') {
        const { lat, lon } = el as { lat: number; lon: number };
        const selected = selectsPbfElement('node', el.tags);
        for (const area of areas) {
          if (inBBox(area.bbox, lat, lon)) {
            area.nodeIds.add(el.id);
            if (selected) area.nodes.push({ type: 'node', id: el.id, lat, lon, ...(el.tags ? { tags: el.tags } : {}) });
          } else if (inBBox(area.pad, lat, lon)) {
            area.ringNodeIds.add(el.id);
          }
        }
      } else if (el.type === 'way') {
        if (blob < firstWayBlob) firstWayBlob = blob;
        const refs = el.refs ?? [];
        const selected = selectsPbfElement('way', el.tags);
        let needed = false;
        for (const area of areas) {
          let inside = false;
          let near = false;
          for (const ref of refs) {
            if (area.nodeIds.has(ref)) {
              inside = true;
              break;
            }
            if (!near && area.ringNodeIds.has(ref)) near = true;
          }
          if (!inside && !near) continue;
          area.nearWayIds.add(el.id);
          if (!selected) continue;
          // A way with a vertex inside the box is in for certain; one that only
          // reaches into the margin is decided on its real geometry, once the
          // third pass has resolved it.
          if (inside) area.selectedWays.add(el.id);
          else area.crossingCandidates.add(el.id);
          needed = true;
        }
        if (needed) {
          wayRefs.set(el.id, refs);
          if (el.tags) wayTags.set(el.id, el.tags);
        }
      } else if (el.type === 'relation') {
        if (!selectsPbfElement('relation', el.tags)) continue;
        const members = el.members ?? [];
        let kept = false;
        for (const area of areas) {
          const touches = members.some((m) =>
            m.type === 'way'
              ? area.nearWayIds.has(m.ref)
              : m.type === 'node'
                ? area.nodeIds.has(m.ref) || area.ringNodeIds.has(m.ref)
                : false,
          );
          if (!touches) continue;
          area.candidateRelations.add(el.id);
          kept = true;
        }
        if (kept) {
          relations.set(el.id, {
            tags: el.tags ?? {},
            members: members.map((m) => ({ type: m.type, ref: m.ref, role: m.role })),
          });
        }
      }
    }
  }, {
    onHeader: (h) => {
      const t = h.osmosis_replication_timestamp;
      if (typeof t === 'number' && t > 0) timestamp = new Date(t * 1000).toISOString();
    },
  });
  log(`pbf: pass 1/3 (${totalBlobs} blocks) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // --- Pass 2: the way section, for relation members pass 1 did not keep -----
  const missingMembers = new Set<number>();
  for (const rel of relations.values()) {
    for (const m of rel.members) {
      if (m.type === 'way' && !wayRefs.has(m.ref)) missingMembers.add(m.ref);
    }
  }
  if (missingMembers.size > 0) {
    const t1 = Date.now();
    let left = missingMembers.size;
    const maxId = Math.max(...missingMembers);
    await scanPbf(
      file,
      (items) => {
        for (const el of items) {
          if (el.type !== 'way') continue;
          if (missingMembers.has(el.id)) {
            wayRefs.set(el.id, el.refs ?? []);
            if (--left === 0) return STOP;
          } else if (el.id > maxId) {
            return STOP; // ways are ascending; nothing left to find
          }
        }
      },
      { fromBlob: Number.isFinite(firstWayBlob) ? firstWayBlob : 0 },
    );
    log(
      `pbf: pass 2/3 resolved ${missingMembers.size - left}/${missingMembers.size} relation-member ways in ${(
        (Date.now() - t1) / 1000
      ).toFixed(1)} s`,
    );
  }

  // --- Pass 3: the node section, for the coordinates ------------------------
  const needed = new Set<number>();
  for (const refs of wayRefs.values()) for (const ref of refs) needed.add(ref);
  for (const rel of relations.values()) {
    for (const m of rel.members) if (m.type === 'node') needed.add(m.ref);
  }
  const coords = new Map<number, OverpassLatLon>();
  if (needed.size > 0) {
    const t2 = Date.now();
    let left = needed.size;
    let maxId = 0;
    for (const id of needed) if (id > maxId) maxId = id;
    await scanPbf(
      file,
      (items) => {
        for (const el of items) {
          if (el.type !== 'node') continue;
          if (needed.has(el.id)) {
            coords.set(el.id, { lat: el.lat!, lon: el.lon! });
            if (--left === 0) return STOP;
          } else if (el.id > maxId) {
            return STOP;
          }
        }
      },
      // Nodes live in the blocks before the first way. `+ 1` because a single
      // block can hold both (the parser reports the block, not the group).
      { toBlob: Number.isFinite(firstWayBlob) ? firstWayBlob + 1 : undefined },
    );
    log(`pbf: pass 3/3 resolved ${coords.size}/${needed.size} nodes in ${((Date.now() - t2) / 1000).toFixed(1)} s`);
  }

  // --- Confirm the elements that only *reach towards* the bbox --------------
  // Now that the geometry is resolved, a way that has no vertex inside the box
  // but crosses it can be recognised, and a relation can be judged on where its
  // members actually run rather than on which margin they touch.
  for (const area of areas) {
    const reaches = (refs: readonly number[]): boolean => {
      const pts = refs
        .map((ref) => coords.get(ref))
        .filter((p): p is OverpassLatLon => p !== undefined)
        .map((p): [number, number] => [p.lon, p.lat]);
      if (pts.some((p) => pointInRect({ x: p[0], z: p[1] }, area.rect))) return true;
      return pts.length >= 2 && clipPolylineToRect(pts, area.rect).length > 0;
    };
    for (const id of area.crossingCandidates) {
      if (reaches(wayRefs.get(id) ?? [])) area.selectedWays.add(id);
    }
    for (const id of area.candidateRelations) {
      const members = relations.get(id)?.members ?? [];
      const touches = members.some((m) =>
        m.type === 'way' ? reaches(wayRefs.get(m.ref) ?? []) : m.type === 'node' ? area.nodeIds.has(m.ref) : false,
      );
      if (touches) area.selectedRelations.add(id);
    }
  }

  // --- Assemble one Overpass-shaped payload per bbox ------------------------
  const fetchedAt = timestamp ?? new Date().toISOString();
  return areas.map((area): PbfExtractResult => {
    let missingNodes = 0;
    const geometryOf = (refs: readonly number[]): (OverpassLatLon | null)[] =>
      refs.map((ref) => {
        const p = coords.get(ref);
        if (!p) missingNodes++;
        return p ?? null;
      });

    const ways: OverpassWay[] = [...area.selectedWays]
      .sort((a, b) => a - b)
      .map((id) => {
        const refs = wayRefs.get(id) ?? [];
        const way: OverpassWay = { type: 'way', id, nodes: refs, geometry: geometryOf(refs) };
        const tags = wayTags.get(id);
        if (tags) way.tags = tags;
        return way;
      });

    const rels: OverpassRelation[] = [...area.selectedRelations]
      .sort((a, b) => a - b)
      .map((id) => {
        const rel = relations.get(id)!;
        const members: OverpassRelationMember[] = rel.members.map((m) => {
          if (m.type === 'way') return { ...m, geometry: geometryOf(wayRefs.get(m.ref) ?? []) };
          if (m.type === 'node') {
            const p = coords.get(m.ref);
            return p ? { ...m, lat: p.lat, lon: p.lon } : { ...m };
          }
          return { ...m };
        });
        const out: OverpassRelation = { type: 'relation', id, members };
        if (Object.keys(rel.tags).length > 0) out.tags = rel.tags;
        return out;
      });

    const nodes = area.nodes.slice().sort((a, b) => a.id - b.id);
    const elements: OverpassElement[] = [...nodes, ...ways, ...rels];
    const raw: OverpassResponse = {
      version: 0.6,
      generator: PBF_GENERATOR,
      elements,
      maprama: { bbox: area.bbox, source: 'pbf', pbfFile: file, fetchedAt },
    };
    return {
      bbox: area.bbox,
      raw,
      stats: {
        elements: elements.length,
        nodes: nodes.length,
        ways: ways.length,
        relations: rels.length,
        missingNodes,
      },
    };
  });
}

/**
 * Counts the nodes of a `.osm.pbf` per slippy tile at zoom `z`, in one pass over
 * the node section.
 *
 * A nationwide tiling run has to decide two things before it does any work: which
 * chunks of the grid are worth visiting at all, and how many chunks it can safely
 * extract in one scan. Both are answered by where the nodes are — South Korea's
 * grid is mostly sea and ridge line, and {@link extractFromPbf}'s memory is
 * driven by how many node coordinates a batch has to resolve.
 *
 * The scan stops at the first way, because a PBF stores all nodes before them.
 *
 * @returns node counts keyed `"<x>/<y>"` at zoom `z`; absent means zero.
 */
export async function surveyPbfNodes(
  file: string,
  z: number,
  options: ExtractFromPbfOptions = {},
): Promise<Map<string, number>> {
  const log = options.log ?? ((): void => {});
  const counts = new Map<string, number>();
  const n = 2 ** z;
  const t0 = Date.now();
  await scanPbf(file, (items) => {
    for (const el of items) {
      if (el.type !== 'node') return el.type === 'way' ? STOP : undefined;
      const lat = el.lat!;
      const lon = el.lon!;
      const s = Math.sin((lat * Math.PI) / 180);
      const mx = (lon + 180) / 360;
      const my = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
      const x = Math.min(n - 1, Math.max(0, Math.floor(mx * n)));
      const y = Math.min(n - 1, Math.max(0, Math.floor(my * n)));
      const key = `${x}/${y}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return undefined;
  });
  log(`pbf: survey at z${z} found ${counts.size} non-empty cells in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return counts;
}

/** Single-bbox {@link extractFromPbf}. */
export async function extractOneFromPbf(
  file: string,
  bbox: BBox,
  options: ExtractFromPbfOptions = {},
): Promise<PbfExtractResult> {
  return (await extractFromPbf(file, [bbox], options))[0]!;
}
