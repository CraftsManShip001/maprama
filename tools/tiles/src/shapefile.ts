/**
 * The smallest ESRI shapefile reader that reads the 토지이음 facility layers:
 * polygon `.shp` geometry plus `.dbf` character attributes.
 *
 * It is deliberately narrow. It handles shape type 5 (Polygon) and nothing
 * else, reads every field as text, and holds one file in memory at a time —
 * which is what these inputs need (the largest `.shp` in the set is 18 MB) and
 * no more. The alternative was a GDAL dependency in the tile build, and the
 * pipeline is meant to stay `npm install`-able.
 *
 * Ring orientation follows the shapefile spec: an outer ring is clockwise
 * (negative signed area in a y-up frame), a hole is counter-clockwise.
 * {@link readPolygonShapefile} hands back the raw parts and lets the caller
 * decide; `kr-parks.ts` keeps outer rings only, because a `GeoPark` has no
 * concept of a hole.
 *
 * @module
 */

import { readFile } from 'node:fs/promises';

/** One polygon record: its parts, each an array of `[x, y]` in the file's own CRS. */
export interface ShapeRecord {
  /** 1-based record number, as stored in the `.shp`. */
  number: number;
  /** Rings, in file order. Closed (last point repeats the first), as the spec requires. */
  parts: [number, number][][];
}

/** A `.dbf` field description. */
export interface DbfField {
  name: string;
  type: string;
  length: number;
}

/** Signed area of a closed ring, in the file's own units squared. Negative = clockwise. */
export function signedArea(ring: readonly (readonly [number, number])[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!;
    const b = ring[i]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

/**
 * Reads every polygon record of a `.shp`.
 *
 * Records of any other shape type (including the null shape, type 0, which the
 * facility layers do contain) come back with no parts, so that record numbering
 * stays aligned with the `.dbf`.
 */
export async function readPolygonShapefile(path: string): Promise<ShapeRecord[]> {
  const buf = await readFile(path);
  const out: ShapeRecord[] = [];
  let at = 100; // file header
  while (at + 8 <= buf.length) {
    const number = buf.readInt32BE(at);
    const contentWords = buf.readInt32BE(at + 4);
    const body = at + 8;
    const next = body + contentWords * 2;
    if (next > buf.length) break;
    const type = buf.readInt32LE(body);
    if (type !== 5) {
      out.push({ number, parts: [] });
      at = next;
      continue;
    }
    const numParts = buf.readInt32LE(body + 36);
    const numPoints = buf.readInt32LE(body + 40);
    const partsAt = body + 44;
    const pointsAt = partsAt + numParts * 4;
    const parts: [number, number][][] = [];
    for (let p = 0; p < numParts; p++) {
      const start = buf.readInt32LE(partsAt + p * 4);
      const end = p + 1 < numParts ? buf.readInt32LE(partsAt + (p + 1) * 4) : numPoints;
      const ring: [number, number][] = [];
      for (let i = start; i < end; i++) {
        const o = pointsAt + i * 16;
        ring.push([buf.readDoubleLE(o), buf.readDoubleLE(o + 8)]);
      }
      parts.push(ring);
    }
    out.push({ number, parts });
    at = next;
  }
  return out;
}

/**
 * Reads a `.dbf` as rows of trimmed strings.
 *
 * `encoding` is passed to `TextDecoder`; the 토지이음 files carry no `.cpg`
 * and are CP949, which Node decodes under the label `euc-kr`.
 */
export async function readDbf(path: string, encoding = 'euc-kr'): Promise<Record<string, string>[]> {
  const buf = await readFile(path);
  const headerBytes = buf.readUInt16LE(8);
  const recordBytes = buf.readUInt16LE(10);
  const recordCount = buf.readUInt32LE(4);
  const decoder = new TextDecoder(encoding);

  const fields: DbfField[] = [];
  for (let at = 32; at + 32 <= headerBytes && buf[at] !== 0x0d; at += 32) {
    const name = decoder.decode(buf.subarray(at, at + 11)).replace(/\0.*$/, '').trim();
    fields.push({ name, type: String.fromCharCode(buf[at + 11]!), length: buf[at + 16]! });
  }

  const rows: Record<string, string>[] = [];
  for (let r = 0; r < recordCount; r++) {
    const at = headerBytes + r * recordBytes;
    if (at + recordBytes > buf.length) break;
    // Deleted rows (`*` in the marker byte) are kept, not skipped: row `r` must
    // stay the attributes of `.shp` record `r + 1`, and dropping one would
    // silently shift every later record's name onto the wrong polygon.
    const row: Record<string, string> = { _deleted: buf[at] === 0x2a ? '1' : '' };
    let o = at + 1;
    for (const f of fields) {
      row[f.name] = decoder.decode(buf.subarray(o, o + f.length)).replace(/\0/g, '').trim();
      o += f.length;
    }
    rows.push(row);
  }
  return rows;
}
