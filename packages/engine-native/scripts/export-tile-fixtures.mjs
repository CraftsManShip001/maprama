#!/usr/bin/env node
/**
 * MTIL v1 tile conformance fixtures, generated from `@maprama/protocol`'s own
 * reader and its test-only writer (`src/__fixtures__/tile.ts`, which is not in
 * the published `dist`), so `export-fixtures.mjs` runs this through tsx:
 *
 *   node --import tsx scripts/export-tile-fixtures.mjs <outDir>
 *
 * Writes `tile.json`: for each case the **exact bytes** of a tile and what
 * `decodeTile` returned for them. `cpp/tests/tile_tests.cpp` decodes the same
 * bytes with `maprama::tile::decodeTile` and compares field by field, so the
 * two readers cannot drift apart.
 *
 * Bytes are a plain array of numbers: a tile fixture is a few hundred bytes, and
 * the C++ JSON parser then needs no base64.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeTile } from '@maprama/protocol';

const outDir = process.argv[2] ?? fileURLToPath(new URL('../cpp/tests/fixtures/', import.meta.url));
const fixtures = new URL('../../protocol/src/__fixtures__/tile.ts', import.meta.url).href;
const { encodeTile, sampleTileLayers } = await import(fixtures);

const bytesOf = (u8) => Array.from(u8);

/** A case the C++ reader must accept and reproduce exactly. */
function okCase(name, bytes) {
  return { name, bytes: bytesOf(bytes), ok: true, tile: decodeTile(bytes) };
}

/**
 * A case both readers must reject. `error` is only compared when
 * `exactError` is true: the TypeScript reader includes byte offsets in its
 * truncation messages, which the C++ one has no reason to reproduce.
 */
function failCase(name, bytes, exactError = false) {
  let error = '';
  try {
    decodeTile(bytes);
    throw new Error(`export-tile-fixtures: case "${name}" was supposed to fail`);
  } catch (e) {
    error = e.message;
  }
  return { name, bytes: bytesOf(bytes), ok: false, error, exactError };
}

const full = encodeTile({ attribution: [0, 1], layers: sampleTileLayers() });
const badMagic = Uint8Array.from(full);
badMagic[0] = 0x58;
const badVersion = Uint8Array.from(full);
badVersion[4] = 2;

const cases = [
  okCase('every layer, every optional field', full),
  okCase('empty tile', encodeTile({ layers: {} })),
  okCase('unclipped (anchor-owned layers only)', encodeTile({ clipped: false, attribution: [0], layers: { buildings: sampleTileLayers().buildings } })),
  okCase('unknown layer id is skipped', encodeTile({
    layers: { stations: sampleTileLayers().stations },
    unknownLayers: [{ id: 9, bytes: Uint8Array.from([1, 2, 3, 4, 5]) }],
  })),
  okCase('non-ASCII names', encodeTile({
    layers: { districts: [{ name: '서울특별시 성동구', u: -1, v: 9000 }, { name: '한강', u: 4096, v: 6200, water: true }] },
  })),
  failCase('too short', Uint8Array.from([0x4d, 0x54, 0x49, 0x4c]), false),
  failCase('bad magic', badMagic, true),
  failCase('unsupported version', badVersion, true),
  failCase('truncated mid-geometry', full.subarray(0, full.length - 5), false),
  failCase('truncated header', full.subarray(0, 8), false),
];

const text = `${JSON.stringify({ cases })}\n`;
writeFileSync(`${outDir}${outDir.endsWith('/') ? '' : '/'}tile.json`, text);
console.log(`export-fixtures: tile.json (${cases.length} entries, ${(text.length / 1024).toFixed(0)} KiB)`);
