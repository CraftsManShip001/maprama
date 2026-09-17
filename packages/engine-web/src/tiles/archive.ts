/**
 * The PMTiles archive a streamed world reads from.
 *
 * This is a thin, deliberately boring wrapper over the official `pmtiles`
 * reader (BSD-3-Clause, pinned to 4.5.0 — the same version `services/api`
 * uses). It owns three things the rest of the engine should not have to know
 * about:
 *
 * - **Range requests.** The reader asks for `bytes=0-16383` once (header + root
 *   directory + metadata), then one range per tile. The engine's WebView has a
 *   `null` origin, so every request is cross-origin: the host has to send
 *   `Access-Control-Allow-Origin: *` **and**
 *   `Access-Control-Expose-Headers: Content-Range, Content-Length, ETag, Accept-Ranges`.
 *   Without the second one the body still arrives and the reader misbehaves in
 *   ways that look like data corruption, so {@link openArchive} says so in the
 *   error message when the first request fails.
 * - **Decompression.** `tile_compression = 2 (gzip)`; the reader handles it
 *   (`DecompressionStream`, falling back to `fflate`).
 * - **The metadata contract.** `format` must be `maprama-mtil-1`; anything else
 *   is refused rather than decoded into nonsense.
 *
 * @module
 */

import { MTIL_FORMAT, validateTileArchiveMetadata, type TileArchiveMetadata } from '@maprama/protocol';

/** Thrown when an archive cannot be opened or read. Mapped to `world_load_failed`. */
export class TileArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TileArchiveError';
  }
}

/** The subset of the `pmtiles` reader this module uses (kept explicit so tests can stub it). */
export interface PMTilesLike {
  getHeader(): Promise<{ minZoom: number; maxZoom: number; tileType: number; tileCompression: number }>;
  getMetadata(): Promise<unknown>;
  getZxy(z: number, x: number, y: number): Promise<{ data: ArrayBuffer } | undefined>;
}

/** Creates the `pmtiles` reader for a URL. Replaced in tests. */
export type PMTilesFactory = (url: string) => PMTilesLike | Promise<PMTilesLike>;

/** An opened archive: what it holds, and how to get one tile out of it. */
export interface TileArchive {
  readonly url: string;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly metadata: TileArchiveMetadata;
  /** Attribution lines the map must display (the string table tiles index into). */
  readonly attribution: readonly string[];
  readonly extent: number;
  readonly buffer: number;
  /**
   * The bytes of one tile, already decompressed, or `null` when the archive has
   * no tile there. **A missing tile is not an error**: South Korea is 60 %
   * mountain and empty tiles are simply not stored, so "no tile" has to mean
   * "empty ground", never a failure.
   */
  getTile(z: number, x: number, y: number): Promise<Uint8Array | null>;
}

const DEFAULT_EXTENT = 8192;
const DEFAULT_BUFFER = 256;

/** The default factory: the official reader, imported lazily so a `data` world never pays for it. */
const defaultFactory: PMTilesFactory = async (url) => {
  const { PMTiles } = await import('pmtiles');
  return new PMTiles(url) as unknown as PMTilesLike;
};

/**
 * Opens an archive and reads its header and metadata (one range request in
 * practice, since the reader fetches the first 16 KiB in one go).
 *
 * @throws TileArchiveError when the archive cannot be read or is not a Maprama tile archive.
 */
export async function openArchive(url: string, factory: PMTilesFactory = defaultFactory): Promise<TileArchive> {
  let reader: PMTilesLike;
  let header: { minZoom: number; maxZoom: number; tileType: number; tileCompression: number };
  let rawMetadata: unknown;
  try {
    reader = await factory(url);
    header = await reader.getHeader();
    rawMetadata = await reader.getMetadata();
  } catch (e) {
    throw new TileArchiveError(
      `failed to read the tile archive at ${url}: ${e instanceof Error ? e.message : String(e)} ` +
        '(the server must support HTTP range requests and, because the engine document has a null origin, send ' +
        'Access-Control-Allow-Origin: * and Access-Control-Expose-Headers: Content-Range, Content-Length, ETag, Accept-Ranges)',
    );
  }
  const v = validateTileArchiveMetadata(rawMetadata);
  if (!v.ok) throw new TileArchiveError(`tile archive at ${url} has invalid metadata: ${v.error}`);
  const metadata = rawMetadata as TileArchiveMetadata;
  if (metadata.format !== MTIL_FORMAT) {
    throw new TileArchiveError(`tile archive at ${url} has format ${JSON.stringify(metadata.format)}, expected ${JSON.stringify(MTIL_FORMAT)}`);
  }
  if (!(header.maxZoom >= header.minZoom)) {
    throw new TileArchiveError(`tile archive at ${url} has an empty zoom range (minZoom ${header.minZoom}, maxZoom ${header.maxZoom})`);
  }
  return {
    url,
    minZoom: header.minZoom,
    maxZoom: header.maxZoom,
    metadata,
    attribution: metadata.attribution ?? [],
    extent: metadata.extent ?? DEFAULT_EXTENT,
    buffer: metadata.buffer ?? DEFAULT_BUFFER,
    async getTile(z, x, y) {
      let res: { data: ArrayBuffer } | undefined;
      try {
        res = await reader.getZxy(z, x, y);
      } catch (e) {
        throw new TileArchiveError(`failed to read tile ${z}/${x}/${y} from ${url}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return res ? new Uint8Array(res.data) : null;
    },
  };
}
