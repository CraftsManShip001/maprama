/**
 * OSM tag classification: road classes, building heights/kinds and POI
 * categories.
 *
 * @module
 */

import type { BuildingKind, PoiCategory, RoadClass } from '@diorama/protocol';
import type { Tags } from './types.js';

/** Storey height used to convert floor counts to meters. */
export const METERS_PER_LEVEL = 3.2;

const ARTERIAL = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'motorway_link',
  'trunk_link',
  'primary_link',
  'secondary_link',
]);
const LOCAL = new Set(['tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street', 'road']);
const WALKABLE = new Set(['footway', 'path', 'pedestrian', 'service', 'track', 'steps', 'cycleway', 'bridleway']);
const SIDEWALK_FOOTWAY = new Set(['sidewalk', 'crossing']);

/** Preferred display name: `name:ko`, then `name`. */
export function displayName(tags: Tags | undefined): string | undefined {
  const name = tags?.['name:ko']?.trim() || tags?.name?.trim();
  return name ? name : undefined;
}

/** Options for {@link classifyRoad}. */
export interface RoadClassifyOptions {
  /** Keep `footway=sidewalk|crossing` ways (default false: they duplicate the carriageway). */
  includeSidewalks?: boolean;
}

/**
 * Maps a `highway=*` way to a {@link RoadClass}; `null` means "not a road we
 * render" (construction, proposed, areas, indoor corridors, platforms...).
 */
export function classifyRoad(tags: Tags | undefined, options: RoadClassifyOptions = {}): RoadClass | null {
  const hw = tags?.highway;
  if (!tags || !hw) return null;
  if (tags.area === 'yes' || tags.indoor === 'yes') return null;
  if (ARTERIAL.has(hw)) return 'arterial';
  if (LOCAL.has(hw)) return 'local';
  if (hw === 'service' && displayName(tags)) return 'local';
  if (WALKABLE.has(hw)) {
    if (!options.includeSidewalks && hw === 'footway' && SIDEWALK_FOOTWAY.has(tags.footway ?? '')) return null;
    return 'alley';
  }
  return null;
}

/** True when the way is tagged as a bridge. */
export function isBridge(tags: Tags | undefined): boolean {
  const b = tags?.bridge;
  return b !== undefined && b !== 'no';
}

/**
 * Parses an OSM length (`"12"`, `"12 m"`, `"12.5m"`, `"40'"`, `"12;15"`) to
 * meters. Returns `undefined` for missing, invalid or non-positive values.
 */
export function parseMeters(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const first = value.split(';')[0]!.trim().replace(',', '.');
  const feetInches = /^(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*")?$/.exec(first);
  if (feetInches) {
    const m = Number(feetInches[1]) * 0.3048 + Number(feetInches[2] ?? 0) * 0.0254;
    return m > 0 ? m : undefined;
  }
  const match = /^(-?\d+(?:\.\d+)?)\s*(m|meters?|metres?|ft|feet)?$/i.exec(first);
  if (!match) return undefined;
  let m = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  if (unit === 'ft' || unit === 'feet') m *= 0.3048;
  return Number.isFinite(m) && m > 0 ? m : undefined;
}

/** Parses a floor count; `undefined` unless a finite number > 0. */
export function parseLevels(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === 'number' ? value : Number(String(value).split(';')[0]!.trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const RESIDENTIAL_LOW = new Set([
  'house',
  'residential',
  'detached',
  'semidetached_house',
  'terrace',
  'bungalow',
  'farm',
  'hut',
  'cabin',
]);
const OFFICE_LIKE = new Set([
  'commercial',
  'office',
  'hotel',
  'hospital',
  'public',
  'civic',
  'government',
  'university',
  'college',
  'school',
  'industrial',
  'warehouse',
  'train_station',
  'transportation',
]);

/** Fallback height in meters from the `building=*` value. */
export function heuristicHeightMeters(building: string | undefined): number {
  switch (building) {
    case 'apartments':
      return 45;
    case 'commercial':
    case 'office':
      return 30;
    case 'retail':
      return 7;
    default:
      return building !== undefined && RESIDENTIAL_LOW.has(building) ? 9 : 12;
  }
}

/** Height/floors from an external source (e.g. the Korean building dataset). */
export interface ExternalHeight {
  heightMeters?: number;
  levels?: number;
}

/** Resolved building height. */
export interface ResolvedHeight {
  heightMeters: number;
  levels?: number;
  source: 'kr-height' | 'kr-levels' | 'height' | 'levels' | 'heuristic';
}

/**
 * Height precedence: external `heightMeters` → external `levels`×3.2 → OSM
 * `height` → OSM `building:levels`×3.2 → {@link heuristicHeightMeters}.
 */
export function resolveHeight(tags: Tags | undefined, external?: ExternalHeight): ResolvedHeight {
  const osmLevels = parseLevels(tags?.['building:levels']);
  const extLevels = parseLevels(external?.levels);
  const levels = extLevels ?? osmLevels;
  const withLevels = (r: Omit<ResolvedHeight, 'levels'>): ResolvedHeight =>
    levels !== undefined ? { ...r, levels: Math.round(levels) } : r;

  if (external?.heightMeters !== undefined && external.heightMeters > 0) {
    return withLevels({ heightMeters: external.heightMeters, source: 'kr-height' });
  }
  if (extLevels !== undefined) return withLevels({ heightMeters: extLevels * METERS_PER_LEVEL, source: 'kr-levels' });
  const h = parseMeters(tags?.height) ?? parseMeters(tags?.['building:height']);
  if (h !== undefined) return withLevels({ heightMeters: h, source: 'height' });
  if (osmLevels !== undefined) return withLevels({ heightMeters: osmLevels * METERS_PER_LEVEL, source: 'levels' });
  return withLevels({ heightMeters: heuristicHeightMeters(tags?.building), source: 'heuristic' });
}

function isGlassy(tags: Tags | undefined): boolean {
  if (!tags) return false;
  const keys = ['building:material', 'building:facade:material', 'facade:material', 'building:cladding'];
  return keys.some((k) => /glass|mirror/i.test(tags[k] ?? ''));
}

function startYear(tags: Tags | undefined): number | undefined {
  const raw = tags?.start_date ?? tags?.['building:start_date'];
  const m = raw ? /(\d{4})/.exec(raw) : null;
  return m ? Number(m[1]) : undefined;
}

/**
 * Facade kind: ≥ 60 m or glass tags → `glass`; tall apartments/residential →
 * `apartment`; commercial/office-like → `office`; small, old, retail, houses →
 * `brick`.
 */
export function classifyKind(tags: Tags | undefined, heightMeters: number): BuildingKind {
  const b = tags?.building ?? 'yes';
  if (heightMeters >= 60 || isGlassy(tags)) return 'glass';
  const year = startYear(tags);
  const old = year !== undefined && year < 1990;
  if (b === 'apartments' || b === 'residential' || b === 'dormitory') {
    return heightMeters >= 20 && !old ? 'apartment' : 'brick';
  }
  if (b === 'retail' || RESIDENTIAL_LOW.has(b)) return 'brick';
  if (OFFICE_LIKE.has(b)) return old && heightMeters < 20 ? 'brick' : 'office';
  if (old) return 'brick';
  return heightMeters >= 20 ? 'office' : 'brick';
}

const MUSIC_NAME = /(?:^|[^A-Za-z])LP(?:$|[^A-Za-z])|레코드|음반/i;

/** POI category for a tagged element, or `null`. */
export function classifyPoi(tags: Tags | undefined): PoiCategory | null {
  if (!tags) return null;
  if (tags.railway === 'station' || tags.station === 'subway') return 'subway';
  const name = displayName(tags) ?? '';
  const isPlace = tags.amenity !== undefined || tags.shop !== undefined || tags.craft !== undefined;
  if (tags.shop === 'music' || (isPlace && MUSIC_NAME.test(name))) return 'music';
  if (tags.amenity === 'cafe') return 'cafe';
  if (tags.shop === 'convenience' || tags.shop === 'supermarket') return 'store';
  if (tags.amenity === 'school' || tags.amenity === 'kindergarten') return 'school';
  if (tags.shop === 'books') return 'book';
  if (tags.leisure === 'park') return 'park';
  if (tags.place === 'square') return 'plaza';
  return null;
}

/** True for `place=neighbourhood|quarter|suburb`. */
export function isDistrictPlace(tags: Tags | undefined): boolean {
  const p = tags?.place;
  return p === 'neighbourhood' || p === 'quarter' || p === 'suburb';
}

/** True for water areas: `natural=water`, `waterway=riverbank`, `water=river`. */
export function isWaterArea(tags: Tags | undefined): boolean {
  if (!tags) return false;
  return tags.natural === 'water' || tags.waterway === 'riverbank' || tags.water === 'river';
}

/** True for green areas: `leisure=park|garden`, `landuse=grass|recreation_ground`. */
export function isParkArea(tags: Tags | undefined): boolean {
  if (!tags) return false;
  return (
    tags.leisure === 'park' ||
    tags.leisure === 'garden' ||
    tags.landuse === 'grass' ||
    tags.landuse === 'recreation_ground'
  );
}

/** True for `building=*` other than `no`. */
export function isBuilding(tags: Tags | undefined): boolean {
  const b = tags?.building;
  return b !== undefined && b !== 'no';
}
