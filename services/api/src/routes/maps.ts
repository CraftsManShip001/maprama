import type { Hono } from 'hono';
import { BLOB_KEYS } from '../config.js';
import type { ServiceDeps } from '../deps.js';
import { ApiError, badRequest } from '../errors.js';
import { authenticate } from '../middleware/auth.js';
import { meter } from '../middleware/usage.js';
import { acceptsEncoding, type AppEnv } from '../util/http.js';
import { TileArchives, TileType, TilesetNotFoundError, buildTileJson, tileContentType, tileExtension } from '../tiles/pmtiles.js';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Authenticated, metered content: cache in the client only, for a long time. */
export const LONG_CACHE = 'private, max-age=86400, stale-while-revalidate=604800';

async function gzip(data: ArrayBuffer): Promise<ArrayBuffer> {
  const source = new Response(data).body;
  if (!source) return data;
  const compressed = source.pipeThrough(new CompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>);
  return new Response(compressed).arrayBuffer();
}

function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(',').some((t) => {
    const v = t.trim();
    return v === '*' || v === etag || v === `W/${etag}`;
  });
}

export function registerMapRoutes(app: Hono<AppEnv>, deps: ServiceDeps): void {
  const archives = new TileArchives(deps.blobs);
  const auth = authenticate(deps, { allowQueryKey: true });
  const tileEncoding = deps.options?.tileEncoding ?? 'app';

  app.get('/v1/worlds/:file', auth, meter(deps, 'world'), async (c) => {
    const m = /^(.+)\.json$/.exec(c.req.param('file'));
    if (!m || !NAME_RE.test(m[1]!)) throw badRequest('World path must be /v1/worlds/<region>.json');
    const key = BLOB_KEYS.world(m[1]!);
    const meta = await deps.blobs.head(key);
    if (!meta) throw new ApiError(404, 'NOT_FOUND', `World "${m[1]}" not found`);
    const etag = `"${meta.etag}"`;
    const headers = new Headers({
      ETag: etag,
      'Cache-Control': LONG_CACHE,
      'Content-Type': 'application/json; charset=utf-8',
    });
    if (etagMatches(c.req.header('if-none-match'), etag)) return new Response(null, { status: 304, headers });
    const obj = await deps.blobs.get(key);
    if (!obj) throw new ApiError(404, 'NOT_FOUND', `World "${m[1]}" not found`);
    headers.set('Content-Length', String(obj.meta.size));
    return new Response(obj.body, { status: 200, headers });
  });

  app.get('/v1/tiles/:file', auth, meter(deps, 'tile'), async (c) => {
    const m = /^(.+)\.json$/.exec(c.req.param('file'));
    if (!m || !NAME_RE.test(m[1]!)) throw badRequest('TileJSON path must be /v1/tiles/<tileset>.json');
    const tileset = m[1]!;
    const archive = archives.get(tileset);
    let header;
    let metadata: unknown = {};
    try {
      header = await archive.getHeader();
    } catch (err) {
      archives.evict(tileset);
      if (err instanceof TilesetNotFoundError) throw new ApiError(404, 'NOT_FOUND', `Tileset "${tileset}" not found`);
      throw err;
    }
    if (header.jsonMetadataLength > 0) {
      try {
        metadata = await archive.getMetadata();
      } catch {
        metadata = {};
      }
    }
    const url = new URL(c.req.url);
    const queryKey = c.req.header('authorization') === undefined ? c.req.query('key') : undefined;
    const tilesUrl = `${url.origin}/v1/tiles/${tileset}/{z}/{x}/{y}${tileExtension(header.tileType)}${queryKey ? `?key=${encodeURIComponent(queryKey)}` : ''}`;
    c.header('Cache-Control', 'private, max-age=3600');
    return c.json(buildTileJson(tileset, header, metadata, tilesUrl));
  });

  app.get('/v1/tiles/:tileset/:z/:x/:file', auth, meter(deps, 'tile'), async (c) => {
    const tileset = c.req.param('tileset');
    if (!NAME_RE.test(tileset)) throw badRequest('Invalid tileset name');
    // `.mvt` for a vector tileset, `.mtil` for a Maprama world archive (design/tile-format.md).
    const ym = /^(\d{1,8})\.(mvt|mtil)$/.exec(c.req.param('file'));
    const zs = c.req.param('z');
    const xs = c.req.param('x');
    if (!ym || !/^\d{1,2}$/.test(zs) || !/^\d{1,8}$/.test(xs)) throw badRequest('Tile path must be /v1/tiles/<tileset>/<z>/<x>/<y>.mvt or .mtil');
    const z = Number(zs);
    const x = Number(xs);
    const y = Number(ym[1]);
    if (z > 26 || x >= 2 ** z || y >= 2 ** z) throw badRequest('Tile coordinates out of range');

    const archive = archives.get(tileset);
    let header;
    try {
      header = await archive.getHeader();
    } catch (err) {
      archives.evict(tileset);
      if (err instanceof TilesetNotFoundError) throw new ApiError(404, 'NOT_FOUND', `Tileset "${tileset}" not found`);
      throw err;
    }
    // Vector tilesets and Maprama world archives are both served; anything else (raster) is not.
    if (header.tileType !== TileType.Mvt && header.tileType !== TileType.Unknown) {
      throw new ApiError(404, 'NOT_FOUND', `Tileset "${tileset}" is not a vector tileset`);
    }
    // The extension has to name what the archive actually holds, so a wrong URL fails loudly
    // instead of handing back bytes the caller cannot parse.
    if (`.${ym[2]}` !== tileExtension(header.tileType)) {
      throw new ApiError(404, 'NOT_FOUND', `Tileset "${tileset}" is served as ${tileExtension(header.tileType)}`);
    }

    const cacheHeaders = { 'Cache-Control': LONG_CACHE, Vary: 'Accept-Encoding' };
    const tile = z < header.minZoom || z > header.maxZoom ? undefined : await archive.getZxy(z, x, y);
    if (!tile || tile.data.byteLength === 0) return new Response(null, { status: 204, headers: cacheHeaders });

    // pmtiles returns decompressed bytes; choose the transfer encoding here.
    const headers = new Headers({ ...cacheHeaders, 'Content-Type': tileContentType(header.tileType) });
    if (!acceptsEncoding(c.req.header('accept-encoding'), 'gzip')) return new Response(tile.data, { status: 200, headers });
    headers.set('Content-Encoding', 'gzip');
    if (tileEncoding === 'runtime') return new Response(tile.data, { status: 200, headers });
    return new Response(await gzip(tile.data), { status: 200, headers });
  });
}
