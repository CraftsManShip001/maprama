/**
 * `buildWorld`: turns an Overpass JSON payload into `WorldData` v1. Pure (no
 * I/O of its own — warnings go to the caller's `warn` sink), deterministic for
 * a given input and options.
 *
 * @module
 */

import {
  DEFAULT_UNIT_METERS,
  createProjection,
  validateWorldData,
  type BuildingFootprint,
  type District,
  type LngLat,
  type Park,
  type Poi,
  type Polygon,
  type Road,
  type Station,
  type Vec2,
  type WorldData,
} from '@maprama/protocol';
import {
  classifyKind,
  classifyPoi,
  classifyRoad,
  displayName,
  isBridge,
  isBuilding,
  isDistrictPlace,
  isParkArea,
  isWaterArea,
  resolveHeight,
  type ResolvedHeight,
} from './classify.js';
import {
  assembleRings,
  clipPolylineToRect,
  clipRingToRect,
  dedupeConsecutive,
  ensureCCW,
  interiorPoint,
  openRing,
  pointInRect,
  pointInRing,
  rectsOverlap,
  removeCollinear,
  ringArea,
  roundTo,
  simplifyLine,
  simplifyRing,
  type Rect,
} from './geometry.js';
import { KrBuildingIndex, OsmFootprintIndex } from './kr.js';
import type { BBox, OverpassElement, OverpassLatLon, OverpassResponse, Tags } from './types.js';

/** Required OSM attribution line (ODbL). */
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
/** Attribution added when Korean national building data is joined. */
export const KR_ATTRIBUTION = '건물 높이: 국가공간정보포털 GIS건물통합정보 (국토교통부)';
/**
 * Id prefix for buildings generated from the Korean national dataset, chosen so
 * it cannot collide with the OSM prefixes `n`/`w`/`r`.
 */
export const KR_ID_PREFIX = 'k';

/** Options for {@link buildWorld}. */
export interface BuildWorldOptions {
  /** Human-readable world name. */
  name: string;
  /** Clip box. Defaults to `raw.maprama.bbox`, else the extent of the raw elements. */
  bbox?: BBox;
  /** World origin. Defaults to the bbox center. */
  origin?: LngLat;
  /** Meters per world unit. Default 8. */
  unitMeters?: number;
  /** Douglas–Peucker tolerance in meters. Default 0.5. */
  simplifyMeters?: number;
  /** Parsed GeoJSON FeatureCollection of the Korean building dataset (EPSG:4326). */
  krBuildings?: unknown;
  /**
   * Also emit buildings for `krBuildings` polygons that no OSM building
   * represents, using the same record's height and floor count. Default false;
   * ignored without {@link BuildWorldOptions.krBuildings}.
   */
  krFillMissing?: boolean;
  /** Keep `footway=sidewalk|crossing` ways. Default false. */
  includeSidewalks?: boolean;
  /** Decimal places for output coordinates (world units). Default 2 (= 8 cm at 8 m/unit). */
  precision?: number;
  /** Minimum building footprint area in m². Default 4. */
  minBuildingAreaM2?: number;
  /** Minimum water/park polygon area in m². Default 25. */
  minAreaM2?: number;
  /**
   * Search radius for attaching a POI to a building, in meters. Default
   * {@link DEFAULT_POI_SNAP_METERS}; `0` only records the building a POI is
   * already inside and never moves a POI.
   */
  poiSnapMeters?: number;
  /** Extra attribution lines appended after the OSM (and KR) lines. */
  attribution?: string[];
  /**
   * Sink for non-fatal build warnings; the CLI passes its stderr writer. The
   * build stays pure and deterministic — a warning never changes what is
   * emitted, and without this option nothing is logged.
   */
  warn?: (message: string) => void;
}

/** Build statistics. */
export interface BuildStats {
  /** Total buildings written: `buildingsFromOsm + buildingsFilled`. */
  buildings: number;
  /** Buildings derived from OSM `building=*` ways and relations. */
  buildingsFromOsm: number;
  /** Buildings generated from national-dataset polygons (`krFillMissing`). */
  buildingsFilled: number;
  /** National-dataset polygons inside the bbox skipped because OSM already has them. */
  krFillSkipped: number;
  roads: number;
  water: number;
  parks: number;
  pois: number;
  /** POIs already inside a building footprint (nothing moved). */
  poisInBuilding: number;
  /** POIs moved onto the nearest footprint within `poiSnapMeters`. */
  poisSnapped: number;
  /** POIs left with no building: none contains them and none is within range. */
  poisUnattached: number;
  stations: number;
  districts: number;
  duplicateBuildings: number;
  heightSources: Record<ResolvedHeight['source'], number>;
  krIndexed: number;
  krMatches: { overlap: number; centroid: number };
}

/** Result of {@link buildWorldWithStats}. */
export interface BuildWorldResult {
  world: WorldData;
  stats: BuildStats;
}

const STATION_MERGE_METERS = 500;

/**
 * Default search radius for attaching a POI to a building, in meters.
 *
 * A large share of OSM POI nodes are not inside the building they describe:
 * mappers put them at the parcel centre, at the entrance, or by the road, and
 * the building is a separate `building=*` way. Measured over five Korean areas
 * (Gangnam, Seongsu, Jeonju, Bundang, Gurye — 171 POIs, 2 460 buildings),
 * 25.1 % of the POIs fall outside every footprint we draw.
 *
 * Of those 43, snapping recovers 12 at 5 m, 20 at 15 m, **28 at 20 m** and 37 at
 * 40 m. 20 m is the default because it is the last step where the second-best
 * candidate is almost never a tie (3 of 28 have another footprint within 2 m of
 * the winner) and where the radius still stays inside one city block: Korean
 * back streets are 6–8 m wide, so 20 m can cross one, while 40 m crosses an
 * arterial (Gangnam-daero is ~50 m) and would attach a shop to the building on
 * the far side of the road — a worse error than leaving it in open space.
 *
 * The remaining 15 of 43 (35 %) stay unattached at 20 m: those are POIs whose
 * building is simply not mapped in OSM, and no threshold fixes them.
 */
export const DEFAULT_POI_SNAP_METERS = 20;

/** How far past a footprint's outline a snapped POI is pulled, in meters. */
export const POI_SNAP_INSET_METERS = 1.5;

/**
 * A plaza further than this from every building footprint is reported as
 * standing in open space (see {@link BuildWorldOptions.warn}).
 */
export const PLAZA_CLEAR_METERS = 15;

/** Nearest point on a ring's outline, and the squared distance to it. */
function nearestOnRing(p: Vec2, ring: readonly Vec2[]): { p: Vec2; d2: number } {
  let bx = ring[0]![0], bz = ring[0]![1], best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i]!;
    const [cx, cz] = ring[(i + 1) % ring.length]!;
    const dx = cx - ax, dz = cz - az;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - az) * dz) / len2)) : 0;
    const qx = ax + t * dx, qz = az + t * dz;
    const d2 = (p[0] - qx) * (p[0] - qx) + (p[1] - qz) * (p[1] - qz);
    if (d2 < best) { best = d2; bx = qx; bz = qz; }
  }
  return { p: [bx, bz], d2: best };
}

/** Distance from `p` to a ring, in the ring's units; 0 when `p` is inside it. */
function distanceToRing(p: Vec2, ring: readonly Vec2[]): number {
  if (pointInRing(p, ring)) return 0;
  return Math.sqrt(nearestOnRing(p, ring).d2);
}

/** Axis-aligned extent of a ring. */
function ringRect(ring: readonly Vec2[]): Rect {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minZ, maxX, maxZ };
}

/**
 * Walks a point on a footprint's outline `inset` units inward, toward the
 * ring's interior point, and keeps walking (in a few widening steps) until it
 * is genuinely inside — a concave footprint can put the first step back
 * outside. Falls back to the interior point itself.
 *
 * Mirrored by `insetIntoRing` in `packages/engine-web/src/labels/anchor.ts`:
 * a POI snapped at build time and a marker snapped at runtime must land in the
 * same place.
 */
export function insetIntoRing(p: Vec2, ring: readonly Vec2[], inset: number): Vec2 {
  const m = interiorPoint(ring);
  const dx = m[0] - p[0], dz = m[1] - p[1];
  const len = Math.hypot(dx, dz);
  if (!(inset > 0) || len <= 1e-9) return pointInRing(p, ring) ? p : m;
  for (const t of [Math.min(inset, len) / len, 0.05, 0.15, 0.35, 0.6]) {
    const q: Vec2 = [p[0] + dx * t, p[1] + dz * t];
    if (pointInRing(q, ring)) return q;
  }
  return m;
}

/**
 * POI categories that describe **open space or an underground facility**, never
 * the inside of a building: a plaza and a park are areas, and a merged subway
 * station sits at the mean of its entrances, usually in the middle of a road.
 * Attaching any of them to the nearest building would move a landmark into a
 * shop and put its label on that shop's roof, so the join skips them entirely —
 * they stay on the ground where the data puts them.
 */
export const OPEN_SPACE_POI_CATEGORIES: ReadonlySet<Poi['cat']> = new Set(['plaza', 'park', 'subway'] as const);

/**
 * Attaches each POI to a building: the one whose footprint contains it, or —
 * within `maxDistance` world units — the nearest one, in which case the POI's
 * position is moved just inside that footprint and the move is recorded
 * (`snapped`, `snapDistanceMeters`).
 *
 * {@link OPEN_SPACE_POI_CATEGORIES} are skipped and counted as unattached.
 *
 * Runs after the buildings are final (including the `--kr-fill-missing` pass),
 * so a POI attaches to a national-dataset building the OSM extract does not
 * have. Mutates `pois` in place and returns the counts.
 */
export function attachPoisToBuildings(
  pois: Poi[],
  buildings: readonly BuildingFootprint[],
  maxDistance: number,
  inset: number,
  unitMeters: number,
  round: (v: number) => number,
): { inBuilding: number; snapped: number; unattached: number } {
  const rects = buildings.map((b) => ringRect(b.footprint));
  let inBuilding = 0, snapped = 0, unattached = 0;
  const max2 = maxDistance * maxDistance;
  for (const poi of pois) {
    if (OPEN_SPACE_POI_CATEGORIES.has(poi.cat)) { unattached++; continue; }
    const p: Vec2 = [poi.x, poi.z];
    let hit: BuildingFootprint | undefined;
    for (let i = 0; i < buildings.length; i++) {
      const r = rects[i]!;
      if (p[0] < r.minX || p[0] > r.maxX || p[1] < r.minZ || p[1] > r.maxZ) continue;
      if (pointInRing(p, buildings[i]!.footprint)) { hit = buildings[i]; break; }
    }
    if (hit) {
      poi.buildingId = hit.id;
      inBuilding++;
      continue;
    }
    if (!(maxDistance > 0)) { unattached++; continue; }
    let best: { b: BuildingFootprint; p: Vec2; d2: number } | undefined;
    for (let i = 0; i < buildings.length; i++) {
      const r = rects[i]!;
      if (p[0] < r.minX - maxDistance || p[0] > r.maxX + maxDistance) continue;
      if (p[1] < r.minZ - maxDistance || p[1] > r.maxZ + maxDistance) continue;
      const near = nearestOnRing(p, buildings[i]!.footprint);
      if (near.d2 > max2) continue;
      if (!best || near.d2 < best.d2) best = { b: buildings[i]!, p: near.p, d2: near.d2 };
    }
    if (!best) { unattached++; continue; }
    const [qx, qz] = insetIntoRing(best.p, best.b.footprint, inset);
    poi.x = round(qx);
    poi.z = round(qz);
    poi.buildingId = best.b.id;
    poi.snapped = true;
    poi.snapDistanceMeters = roundTo(Math.sqrt(best.d2) * unitMeters, 2);
    snapped++;
  }
  return { inBuilding, snapped, unattached };
}

/** Extent of every coordinate in the payload. Throws when there is none. */
export function inferBBox(raw: OverpassResponse): BBox {
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  const add = (p: OverpassLatLon | null | undefined): void => {
    if (!p) return;
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
    west = Math.min(west, p.lon);
    east = Math.max(east, p.lon);
  };
  for (const el of raw.elements) {
    if (el.type === 'node') add(el);
    else if (el.type === 'way') el.geometry?.forEach(add);
    else el.members?.forEach((m) => (m.geometry ? m.geometry.forEach(add) : m.lat !== undefined ? add(m as OverpassLatLon) : undefined));
  }
  if (!Number.isFinite(south)) throw new Error('buildWorld: cannot infer bbox from an empty payload; pass options.bbox');
  return { south, west, north, east };
}

/** Throws a RangeError for an invalid bbox. */
export function assertBBox(bbox: BBox): void {
  const { south, west, north, east } = bbox;
  const ok =
    [south, west, north, east].every((v) => typeof v === 'number' && Number.isFinite(v)) &&
    south >= -90 &&
    north <= 90 &&
    west >= -180 &&
    east <= 180 &&
    south < north &&
    west < east;
  if (!ok) throw new RangeError(`invalid bbox ${JSON.stringify(bbox)} (expected south < north, west < east)`);
}

/** Builds `WorldData` from an Overpass payload. See {@link buildWorldWithStats}. */
export function buildWorld(raw: OverpassResponse, options: BuildWorldOptions): WorldData {
  return buildWorldWithStats(raw, options).world;
}

function prefix(el: OverpassElement): string {
  return el.type === 'node' ? 'n' : el.type === 'way' ? 'w' : 'r';
}

/** Outer rings (lat/lon, open) of a closed way or a multipolygon relation. */
function areaRings(el: OverpassElement): OverpassLatLon[][] {
  const key = (p: OverpassLatLon): string => `${p.lat},${p.lon}`;
  if (el.type === 'way') {
    const g = (el.geometry ?? []).filter((p): p is OverpassLatLon => p !== null);
    if (g.length >= 4 && key(g[0]!) === key(g[g.length - 1]!)) return [g.slice(0, -1)];
    return [];
  }
  if (el.type === 'relation') {
    const type = el.tags?.type;
    if (type !== 'multipolygon' && type !== undefined) return [];
    const segments = (el.members ?? [])
      .filter((m) => m.type === 'way' && (m.role === 'outer' || m.role === '') && m.geometry)
      .map((m) => m.geometry!.filter((p): p is OverpassLatLon => p !== null));
    return assembleRings(segments, key);
  }
  return [];
}

function wayPoints(el: OverpassElement): OverpassLatLon[] {
  return el.type === 'way' ? (el.geometry ?? []).filter((p): p is OverpassLatLon => p !== null) : [];
}

/**
 * Builds `WorldData` and statistics.
 *
 * Buildings: closed `building=*` ways and multipolygon relations (outer rings),
 * projected, simplified, clipped to the bbox, made counter-clockwise and
 * deduplicated. With `krFillMissing`, national-dataset polygons that no OSM
 * building represents are added afterwards, through the same pipeline. Roads:
 * `highway=*` polylines split at the bbox edge. Water, parks, POIs, stations
 * (merged by name), districts and a plaza are derived as documented in the
 * package README.
 *
 * @throws RangeError for invalid options; Error if the result fails `validateWorldData`.
 */
export function buildWorldWithStats(raw: OverpassResponse, options: BuildWorldOptions): BuildWorldResult {
  if (!raw || !Array.isArray(raw.elements)) throw new TypeError('buildWorld: raw must be an Overpass JSON object with elements[]');
  const unitMeters = options.unitMeters ?? DEFAULT_UNIT_METERS;
  const bbox = options.bbox ?? raw.maprama?.bbox ?? inferBBox(raw);
  assertBBox(bbox);
  const origin: LngLat = options.origin ?? { lat: (bbox.south + bbox.north) / 2, lng: (bbox.west + bbox.east) / 2 };
  const projection = createProjection({ origin, unitMeters });
  const simplifyMeters = options.simplifyMeters ?? 0.5;
  if (!(simplifyMeters >= 0)) throw new RangeError('simplifyMeters must be >= 0');
  const tolerance = simplifyMeters / unitMeters;
  const precision = options.precision ?? 2;
  const minBuildingArea = (options.minBuildingAreaM2 ?? 4) / (unitMeters * unitMeters);
  const minArea = (options.minAreaM2 ?? 25) / (unitMeters * unitMeters);

  const nw = projection.toWorld({ lng: bbox.west, lat: bbox.north });
  const se = projection.toWorld({ lng: bbox.east, lat: bbox.south });
  const rect: Rect = { minX: nw.x, minZ: nw.z, maxX: se.x, maxZ: se.z };

  const toVec = (p: OverpassLatLon): Vec2 => {
    const w = projection.toWorld({ lng: p.lon, lat: p.lat });
    return [w.x, w.z];
  };
  const round = (v: number): number => roundTo(v, precision);
  const kr = options.krBuildings !== undefined ? KrBuildingIndex.fromGeoJson(options.krBuildings, projection) : undefined;

  /** Projected, open, de-duplicated ring (unsimplified, unclipped). */
  const project = (ring: OverpassLatLon[]): Vec2[] => dedupeConsecutive(openRing(ring.map(toVec)), true);

  /** Simplify → clip → round → clean → CCW. `null` when degenerate or too small. */
  const finishRing = (projected: Vec2[], min: number): Vec2[] | null => {
    if (projected.length < 3) return null;
    let ring = simplifyRing(projected, tolerance);
    ring = clipRingToRect(ring, rect);
    ring = ring.map((p) => [round(p[0]), round(p[1])] as Vec2);
    ring = removeCollinear(dedupeConsecutive(ring, true), 1e-12);
    if (ring.length < 3 || ringArea(ring) < min) return null;
    return ensureCCW(ring);
  };

  const stats: BuildStats = {
    buildings: 0,
    buildingsFromOsm: 0,
    buildingsFilled: 0,
    krFillSkipped: 0,
    roads: 0,
    water: 0,
    parks: 0,
    pois: 0,
    poisInBuilding: 0,
    poisSnapped: 0,
    poisUnattached: 0,
    stations: 0,
    districts: 0,
    duplicateBuildings: 0,
    heightSources: { 'kr-height': 0, 'kr-levels': 0, height: 0, levels: 0, heuristic: 0 },
    krIndexed: kr?.size ?? 0,
    krMatches: { overlap: 0, centroid: 0 },
  };

  const buildings: BuildingFootprint[] = [];
  const roads: Road[] = [];
  const water: Polygon[] = [];
  const parks: Park[] = [];
  let pois: Poi[] = [];
  const districts: District[] = [];
  const seenFootprints = new Set<string>();
  const seenIds = new Set<string>();
  const namedWater = new Map<string, { area: number; ring: Vec2[] }>();
  /** Projected rings of the OSM buildings actually written, for the fill-in pass. */
  const osmRings: Vec2[][] = [];
  /** Indices of national-dataset records an OSM building already matched. */
  const matchedKr = new Set<number>();
  const footprintKey = (ring: Vec2[]): string =>
    ring
      .map((p) => `${p[0]},${p[1]}`)
      .sort()
      .join(';');

  for (const el of raw.elements) {
    const tags: Tags | undefined = el.tags;
    if (!tags) continue;
    const baseId = `${prefix(el)}${el.id}`;

    // Buildings
    if (isBuilding(tags) && el.type !== 'node') {
      const rings = areaRings(el);
      rings.forEach((llRing, k) => {
        const projected = project(llRing);
        const footprint = finishRing(projected, minBuildingArea);
        if (!footprint) return;
        const id = rings.length > 1 ? `${baseId}_${k}` : baseId;
        const key = footprintKey(footprint);
        if (seenFootprints.has(key) || seenIds.has(id)) {
          stats.duplicateBuildings++;
          return;
        }
        seenFootprints.add(key);
        seenIds.add(id);
        osmRings.push(projected);
        const match = kr?.match(projected);
        if (match) {
          stats.krMatches[match.method]++;
          matchedKr.add(match.index);
        }
        const height = resolveHeight(tags, match);
        stats.heightSources[height.source]++;
        const b: BuildingFootprint = { id, footprint, height: roundTo(height.heightMeters / unitMeters, 3) };
        if (height.levels !== undefined) b.levels = height.levels;
        b.kind = classifyKind(tags, height.heightMeters);
        const name = displayName(tags);
        if (name) b.name = name;
        buildings.push(b);
        stats.buildingsFromOsm++;
      });
    }

    // Roads
    if (el.type === 'way' && tags.highway) {
      const cls = classifyRoad(tags, { includeSidewalks: options.includeSidewalks });
      if (cls) {
        const pts = simplifyLine(dedupeConsecutive(wayPoints(el).map(toVec), false), tolerance);
        if (pts.length >= 2) {
          const pieces = clipPolylineToRect(pts, rect)
            .map((piece) => dedupeConsecutive(piece.map((p) => [round(p[0]), round(p[1])] as Vec2), false))
            .filter((piece) => piece.length >= 2);
          pieces.forEach((piece, i) => {
            const road: Road = { id: pieces.length > 1 ? `${baseId}_${i}` : baseId, cls, pts: piece };
            const name = displayName(tags);
            if (name) road.name = name;
            if (isBridge(tags)) road.bridge = true;
            roads.push(road);
          });
        }
      }
    }

    // Water
    if (isWaterArea(tags) && el.type !== 'node') {
      for (const llRing of areaRings(el)) {
        const poly = finishRing(project(llRing), minArea);
        if (!poly) continue;
        water.push(poly);
        const name = displayName(tags);
        if (name) {
          const area = ringArea(poly);
          const prev = namedWater.get(name);
          if (!prev || prev.area < area) namedWater.set(name, { area, ring: poly });
        }
      }
    }

    // Parks
    if (isParkArea(tags) && el.type !== 'node') {
      for (const llRing of areaRings(el)) {
        const poly = finishRing(project(llRing), minArea);
        if (!poly) continue;
        const park: Park = { poly };
        const name = displayName(tags);
        if (name) park.name = name;
        parks.push(park);
      }
    }

    // POIs
    const cat = classifyPoi(tags);
    const name = displayName(tags);
    if (cat && name) {
      let pos: Vec2 | undefined;
      if (el.type === 'node') {
        pos = toVec(el);
      } else {
        let best: Vec2[] | null = null;
        for (const llRing of areaRings(el)) {
          const poly = finishRing(project(llRing), 0);
          if (poly && (!best || ringArea(poly) > ringArea(best))) best = poly;
        }
        if (best) pos = interiorPoint(best);
        else {
          const pts = wayPoints(el);
          if (pts.length > 0) pos = toVec(pts[Math.floor(pts.length / 2)]!);
        }
      }
      if (pos && pointInRect({ x: pos[0], z: pos[1] }, rect)) {
        pois.push({ id: baseId, name, cat, x: round(pos[0]), z: round(pos[1]) });
      }
    }

    // Districts
    if (el.type === 'node' && isDistrictPlace(tags) && name) {
      const p = toVec(el);
      if (pointInRect({ x: p[0], z: p[1] }, rect)) districts.push({ name, x: round(p[0]), z: round(p[1]) });
    }
  }

  // Fill gaps: national-dataset polygons the OSM extract does not cover. A
  // record counts as "already represented" when an OSM building matched it
  // (KrBuildingIndex.match), or when an OSM footprint covers >= KR_MIN_OVERLAP
  // of the record's own area or contains its centroid (OsmFootprintIndex).
  if (kr && options.krFillMissing) {
    const osmIndex = new OsmFootprintIndex();
    for (const ring of osmRings) osmIndex.add(ring);
    for (const record of kr.records) {
      if (!rectsOverlap(record.rect, rect)) continue; // wholly outside the clip box
      if (matchedKr.has(record.index) || osmIndex.covers(record.ring)) {
        stats.krFillSkipped++;
        continue;
      }
      const footprint = finishRing(record.ring, minBuildingArea);
      if (!footprint) continue;
      const key = footprintKey(footprint);
      if (seenFootprints.has(key)) {
        stats.krFillSkipped++;
        continue;
      }
      let id = `${KR_ID_PREFIX}${record.key}`;
      for (let n = 1; seenIds.has(id); n++) id = `${KR_ID_PREFIX}${record.key}_${n}`;
      seenFootprints.add(key);
      seenIds.add(id);
      // The dataset carries no OSM tags, so height comes from the record and
      // the facade kind falls back to the same rules an untagged building gets.
      const height = resolveHeight(undefined, record);
      stats.heightSources[height.source]++;
      const b: BuildingFootprint = { id, footprint, height: roundTo(height.heightMeters / unitMeters, 3) };
      if (height.levels !== undefined) b.levels = height.levels;
      b.kind = classifyKind(undefined, height.heightMeters);
      buildings.push(b);
      stats.buildingsFilled++;
    }
  }

  // Stations: merge subway POIs with the same name that lie close together.
  const mergeDist = STATION_MERGE_METERS / unitMeters;
  const groups: { id: string; name: string; xs: number[]; zs: number[] }[] = [];
  for (const poi of pois.filter((p) => p.cat === 'subway')) {
    const mean = (v: number[]): number => v.reduce((a, b) => a + b, 0) / v.length;
    const group = groups.find(
      (g) => g.name === poi.name && Math.hypot(mean(g.xs) - poi.x, mean(g.zs) - poi.z) <= mergeDist,
    );
    if (group) {
      group.xs.push(poi.x);
      group.zs.push(poi.z);
    } else {
      groups.push({ id: poi.id, name: poi.name, xs: [poi.x], zs: [poi.z] });
    }
  }
  const stations: Station[] = groups.map((g) => ({
    id: g.id,
    name: g.name,
    x: round(g.xs.reduce((a, b) => a + b, 0) / g.xs.length),
    z: round(g.zs.reduce((a, b) => a + b, 0) / g.zs.length),
  }));
  pois = [
    ...pois.filter((p) => p.cat !== 'subway'),
    ...stations.map((s): Poi => ({ id: s.id, name: s.name, cat: 'subway', x: s.x, z: s.z })),
  ];

  // POI ↔ building join. Last, so it sees every building (including the ones
  // `krFillMissing` added) and the merged station POIs.
  const poiSnap = (options.poiSnapMeters ?? DEFAULT_POI_SNAP_METERS) / unitMeters;
  const attach = attachPoisToBuildings(pois, buildings, poiSnap, POI_SNAP_INSET_METERS / unitMeters, unitMeters, round);
  stats.poisInBuilding = attach.inBuilding;
  stats.poisSnapped = attach.snapped;
  stats.poisUnattached = attach.unattached;

  // Named water bodies become water district labels.
  for (const [wname, { ring }] of namedWater) {
    const p = interiorPoint(ring);
    districts.push({ name: wname, x: round(p[0]), z: round(p[1]), water: true });
  }
  const uniqueDistricts = districts.filter((d, i) => districts.findIndex((o) => o.name === d.name) === i);

  // Plaza: the named square closest to the origin.
  const squares = pois.filter((p) => p.cat === 'plaza').sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
  const plazaPoi = squares[0];
  if (plazaPoi && options.warn) {
    const gaps = buildings.map((b) => distanceToRing([plazaPoi.x, plazaPoi.z], b.footprint));
    const gap = gaps.length > 0 ? Math.min(...gaps) * unitMeters : Infinity;
    if (gap > PLAZA_CLEAR_METERS) {
      const near = Number.isFinite(gap)
        ? `the nearest building footprint is ${gap.toFixed(1)} m away`
        : 'this world has no building footprints at all';
      options.warn(
        `warning: plaza "${plazaPoi.name}" at (${plazaPoi.x}, ${plazaPoi.z}) stands in open space — ${near}.`,
      );
      options.warn(
        '  That is fine, and the plaza is emitted as-is; but a renderer that anchors something at world.plaza will have nothing under it.',
      );
    }
  }

  const attribution = [OSM_ATTRIBUTION, ...(kr ? [KR_ATTRIBUTION] : []), ...(options.attribution ?? [])].filter(
    (line, i, all) => all.indexOf(line) === i,
  );

  const world: WorldData = {
    version: 1,
    name: options.name,
    origin: { lng: origin.lng, lat: origin.lat },
    unitMeters,
    bounds: { minX: round(rect.minX), minZ: round(rect.minZ), maxX: round(rect.maxX), maxZ: round(rect.maxZ) },
    roads,
    buildings,
    water,
    parks,
    pois,
    stations,
    districts: uniqueDistricts,
    ...(squares[0] ? { plaza: { x: squares[0].x, z: squares[0].z } } : {}),
    attribution,
  };

  const result = validateWorldData(world);
  if (!result.ok) throw new Error(`buildWorld produced invalid WorldData: ${result.error}`);

  stats.buildings = buildings.length;
  stats.roads = roads.length;
  stats.water = water.length;
  stats.parks = parks.length;
  stats.pois = pois.length;
  stats.stations = stations.length;
  stats.districts = uniqueDistricts.length;
  return { world, stats };
}

/**
 * Serializes a world with one feature per line: compact, yet diff-friendly
 * when checked into git.
 */
export function stringifyWorld(world: WorldData): string {
  const entries = Object.entries(world);
  const lines = ['{'];
  entries.forEach(([key, value], i) => {
    const comma = i < entries.length - 1 ? ',' : '';
    if (Array.isArray(value) && value.length > 0) {
      lines.push(`  ${JSON.stringify(key)}: [`);
      value.forEach((item, j) => lines.push(`    ${JSON.stringify(item)}${j < value.length - 1 ? ',' : ''}`));
      lines.push(`  ]${comma}`);
    } else {
      lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)}${comma}`);
    }
  });
  lines.push('}');
  return `${lines.join('\n')}\n`;
}
