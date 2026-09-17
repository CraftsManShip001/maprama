/**
 * Reading an archive back with the **official** `pmtiles` package.
 *
 * The writer in `pmtiles.ts` implements the spec from scratch, so the only
 * meaningful check that it got the bytes right is a reader nobody here wrote.
 * This module is the adapter that lets that reader work against a local file,
 * and it is used by both the CLI (`verify`, `inspect`, `water`) and the tests.
 *
 * @module
 */

import { open } from 'node:fs/promises';
import { PMTiles, type RangeResponse, type Source } from 'pmtiles';
import { decodeTile, type DecodedTile } from './mtil.js';

/** A `pmtiles` {@link Source} over a local file, so `verify` needs no HTTP server. */
export class FileSource implements Source {
  constructor(readonly path: string) {}

  getKey(): string {
    return this.path;
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const handle = await open(this.path, 'r');
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, offset);
      const slice = buf.subarray(0, bytesRead);
      return { data: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) as ArrayBuffer };
    } finally {
      await handle.close();
    }
  }
}

/** Opens an archive with the official reader. */
export function openArchive(path: string): PMTiles {
  return new PMTiles(new FileSource(path));
}

/** Reads and decodes one MTIL tile, or `undefined` when the archive has no such tile. */
export async function readTile(archive: PMTiles, z: number, x: number, y: number): Promise<DecodedTile | undefined> {
  const result = await archive.getZxy(z, x, y);
  if (!result) return undefined;
  return decodeTile(Buffer.from(result.data));
}
