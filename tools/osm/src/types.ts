/**
 * Types for raw Overpass API JSON (`[out:json]` with `out geom`) and the small
 * metadata block `maprama-osm fetch` adds to the files it writes.
 *
 * @module
 */

/** OSM tag map. */
export type Tags = Record<string, string>;

/** A coordinate as returned by Overpass (`out geom`). */
export interface OverpassLatLon {
  lat: number;
  lon: number;
}

/** Geographic bounding box in degrees. */
export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface OverpassNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Tags;
}

export interface OverpassWay {
  type: 'way';
  id: number;
  tags?: Tags;
  nodes?: number[];
  /** Present with `out geom`. Entries may be `null` when a node is missing. */
  geometry?: (OverpassLatLon | null)[];
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
}

export interface OverpassRelationMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role: string;
  /** Present for way members with `out geom`. */
  geometry?: (OverpassLatLon | null)[];
  /** Present for node members with `out geom`. */
  lat?: number;
  lon?: number;
}

export interface OverpassRelation {
  type: 'relation';
  id: number;
  tags?: Tags;
  members?: OverpassRelationMember[];
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
}

export type OverpassElement = OverpassNode | OverpassWay | OverpassRelation;

/** Metadata `maprama-osm` stores next to the raw payload it writes. */
export interface RawMeta {
  bbox: BBox;
  /** Which input produced this payload. Absent means Overpass (the original path). */
  source?: 'overpass' | 'pbf';
  /** Overpass endpoint the payload came from. */
  endpoint?: string;
  /**
   * When the data was obtained: the request time for Overpass, the extract's
   * replication timestamp for a PBF.
   */
  fetchedAt?: string;
  /** Overpass QL that produced the payload. */
  query?: string;
  /** Path of the `.osm.pbf` the payload was extracted from. */
  pbfFile?: string;
}

/** An Overpass JSON response (optionally with `maprama` metadata). */
export interface OverpassResponse {
  version?: number;
  generator?: string;
  osm3s?: { timestamp_osm_base?: string; copyright?: string };
  /** Overpass reports runtime errors/timeouts here while still returning HTTP 200. */
  remark?: string;
  elements: OverpassElement[];
  maprama?: RawMeta;
}
