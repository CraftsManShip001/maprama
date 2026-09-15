/**
 * PMTiles v3 archives read through the `BlobStore` range API (R2 in production).
 */
import { EtagMismatch, PMTiles, TileType, tileTypeExt, type Header, type RangeResponse, type Source } from 'pmtiles';
import { BLOB_KEYS } from '../config.js';
import type { BlobStore } from '../deps.js';

export class TilesetNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`Tileset archive not found: ${key}`);
    this.name = 'TilesetNotFoundError';
  }
}

/** A pmtiles `Source` that reads byte ranges from a `BlobStore` object. */
export class BlobRangeSource implements Source {
  constructor(
    private readonly blobs: BlobStore,
    private readonly key: string,
  ) {}

  getKey(): string {
    return this.key;
  }

  async getBytes(offset: number, length: number, _signal?: AbortSignal, etag?: string): Promise<RangeResponse> {
    const res = await this.blobs.getRange(this.key, offset, length);
    if (!res) throw new TilesetNotFoundError(this.key);
    if (etag && res.meta.etag !== etag) throw new EtagMismatch(`ETag changed for ${this.key}`);
    return { data: res.data, etag: res.meta.etag };
  }
}

/** Bounded cache of open archives, keyed by tileset name. */
export class TileArchives {
  private readonly archives = new Map<string, PMTiles>();

  constructor(
    private readonly blobs: BlobStore,
    private readonly maxOpen = 32,
  ) {}

  get(tileset: string): PMTiles {
    let archive = this.archives.get(tileset);
    if (archive) {
      this.archives.delete(tileset);
      this.archives.set(tileset, archive);
      return archive;
    }
    archive = new PMTiles(new BlobRangeSource(this.blobs, BLOB_KEYS.tiles(tileset)));
    this.archives.set(tileset, archive);
    while (this.archives.size > this.maxOpen) {
      const oldest = this.archives.keys().next().value;
      if (oldest === undefined) break;
      this.archives.delete(oldest);
    }
    return archive;
  }

  /** Drops a cached archive (pmtiles caches rejected header promises, so errors must evict). */
  evict(tileset: string): void {
    this.archives.delete(tileset);
  }
}

/** MIME type for a pmtiles tile type. */
export function tileContentType(tileType: TileType): string {
  switch (tileType) {
    case TileType.Mvt:
      return 'application/vnd.mapbox-vector-tile';
    case TileType.Png:
      return 'image/png';
    case TileType.Jpeg:
      return 'image/jpeg';
    case TileType.Webp:
      return 'image/webp';
    case TileType.Avif:
      return 'image/avif';
    default:
      return 'application/octet-stream';
  }
}

export interface TileJson {
  tilejson: '3.0.0';
  name: string;
  description?: string;
  version?: string;
  attribution?: string;
  scheme: 'xyz';
  tiles: string[];
  minzoom: number;
  maxzoom: number;
  bounds: [number, number, number, number];
  center: [number, number, number];
  vector_layers: unknown[];
}

/** Builds TileJSON 3.0.0 from a PMTiles header and its JSON metadata. */
export function buildTileJson(tileset: string, header: Header, metadata: unknown, tilesUrl: string): TileJson {
  const meta = typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {};
  const str = (k: string): string | undefined => (typeof meta[k] === 'string' ? (meta[k] as string) : undefined);
  const out: TileJson = {
    tilejson: '3.0.0',
    name: str('name') ?? tileset,
    scheme: 'xyz',
    tiles: [tilesUrl],
    minzoom: header.minZoom,
    maxzoom: header.maxZoom,
    bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
    center: [header.centerLon, header.centerLat, header.centerZoom],
    vector_layers: Array.isArray(meta.vector_layers) ? meta.vector_layers : [],
  };
  const description = str('description');
  const version = str('version');
  const attribution = str('attribution');
  if (description !== undefined) out.description = description;
  if (version !== undefined) out.version = version;
  if (attribution !== undefined) out.attribution = attribution;
  return out;
}

export { TileType, tileTypeExt };
