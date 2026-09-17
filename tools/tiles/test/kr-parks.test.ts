/**
 * The Korean national park source, end to end on real bytes.
 *
 * `test/fixtures/kr-parks/seoul/UPIS_C_UQ153.*` (34 KB) is six records cut out
 * of the real 2026-08 Seoul issue of 토지이음 (도시계획)시설정보: four parks
 * (`UQT2`), one 완충녹지 (`UQT3`) and one 공공공지 (`UQT5`). It is real bytes on
 * purpose — the CP949 names, the EPSG:5174 coordinates, the multipart rings and
 * the one-column-shifted classification are all things a hand-written fixture
 * would quietly get right and the real file gets wrong.
 *
 * The four parks have independently known positions, so a datum shift that
 * silently changed would move them off their landmarks and fail here.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KR_PARK_GROUPS,
  KR_PARKS_ATTRIBUTION,
  KrParksSource,
  convertKrParks,
  encodeKrParksFile,
} from '../src/kr-parks.js';
import { readDbf, readPolygonShapefile, signedArea } from '../src/shapefile.js';
import { attributionIndices, attributionTable, tileAttribution, type LayerRouting } from '../src/sources.js';
import { LAYER_NAMES, type LayerName } from '../src/types.js';
import type { GeoBundle } from '../src/types.js';
import type { Region, TileSource } from '../src/sources.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures', 'kr-parks');
const SHAPE = join(FIXTURES, 'seoul', 'UPIS_C_UQ153');

/** Where each landmark actually is, to a few metres. */
const LANDMARKS: Record<string, [number, number]> = {
  남산공원: [126.94638, 37.57727],
  서울숲공원: [127.03983, 37.54504],
  여의도근린공원: [126.92288, 37.52623],
  보라매공원: [126.91927, 37.49283],
};

const centre = (poly: readonly (readonly [number, number])[]): [number, number] => {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [lng, lat] of poly) {
    w = Math.min(w, lng);
    e = Math.max(e, lng);
    s = Math.min(s, lat);
    n = Math.max(n, lat);
  }
  return [(w + e) / 2, (s + n) / 2];
};

describe('shapefile reader', () => {
  it('reads the polygon records and keeps them aligned with the .dbf', async () => {
    const shapes = await readPolygonShapefile(`${SHAPE}.shp`);
    const rows = await readDbf(`${SHAPE}.dbf`);
    expect(shapes).toHaveLength(6);
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r['DGM_NM'])).toEqual([
      '완충녹지',
      '공공공지',
      '남산공원',
      '보라매공원',
      '서울숲공원',
      '여의도근린공원',
    ]);
  });

  it('decodes CP949 names', async () => {
    const rows = await readDbf(`${SHAPE}.dbf`);
    // A latin-1 read would give mojibake; the point is that these are real hangul.
    expect(rows[2]!['DGM_NM']).toBe('남산공원');
    expect(rows[2]!['DGM_NM']!.charCodeAt(0)).toBe('남'.charCodeAt(0));
  });

  it('sees the classification columns shifted one place left', async () => {
    const rows = await readDbf(`${SHAPE}.dbf`);
    // 남산공원 is 도시자연공원 = UQT230, and the file puts it in MLSFC_CL with
    // SCLAS_CL empty — which is why the leaf code is "the last non-empty one".
    expect(rows[2]!['LCLAS_CL']).toBe('UQT200');
    expect(rows[2]!['MLSFC_CL']).toBe('UQT230');
    expect(rows[2]!['SCLAS_CL']).toBe('');
  });

  it('orients outer rings clockwise, as the shapefile spec requires', async () => {
    const shapes = await readPolygonShapefile(`${SHAPE}.shp`);
    for (const shape of shapes) {
      expect(shape.parts.some((ring) => signedArea(ring) < 0)).toBe(true);
    }
  });
});

describe('convertKrParks', () => {
  it('keeps the parks and drops 녹지/공공공지 by default', async () => {
    const { parks, stats } = await convertKrParks({ dir: FIXTURES });
    expect(stats.records).toBe(6);
    expect(stats.matched).toBe(4);
    const names = new Set(parks.map((p) => p.name));
    expect(names).toEqual(new Set(Object.keys(LANDMARKS)));
    expect(parks.every((p) => p.poly.length >= 3)).toBe(true);
  });

  it('puts each park on its landmark', async () => {
    const { parks } = await convertKrParks({ dir: FIXTURES });
    for (const [name, [lng, lat]] of Object.entries(LANDMARKS)) {
      // Take the largest piece of a multipart park: the small ones are outlying
      // fragments of the same decision and are not centred on the landmark.
      const pieces = parks.filter((p) => p.name === name);
      expect(pieces.length).toBeGreaterThan(0);
      const biggest = pieces.reduce((a, b) => (b.poly.length > a.poly.length ? b : a));
      const [gotLng, gotLat] = centre(biggest.poly);
      // Within ~400 m of the landmark: a datum shift error is kilometres, and a
      // missing shift is ~350 m in latitude alone.
      expect(Math.abs(gotLng - lng)).toBeLessThan(0.005);
      expect(Math.abs(gotLat - lat)).toBeLessThan(0.005);
    }
  });

  it('adds 녹지 and 공공공지 when asked for them', async () => {
    const { parks } = await convertKrParks({ dir: FIXTURES, groups: ['park', 'green', 'openspace'] });
    expect(parks.some((p) => p.name === '완충녹지')).toBe(true);
    expect(parks.some((p) => p.name === '공공공지')).toBe(true);
  });

  it('drops polygons under the minimum area', async () => {
    const all = await convertKrParks({ dir: FIXTURES, minAreaM2: 0 });
    const big = await convertKrParks({ dir: FIXTURES, minAreaM2: 100_000 });
    expect(big.parks.length).toBeLessThan(all.parks.length);
    expect(big.stats.droppedSmall).toBeGreaterThan(0);
  });

  it('opens the rings — the last point is not the first', async () => {
    const { parks } = await convertKrParks({ dir: FIXTURES });
    for (const p of parks) {
      const first = p.poly[0]!;
      const last = p.poly[p.poly.length - 1]!;
      expect(first[0] === last[0] && first[1] === last[1]).toBe(false);
    }
  });
});

describe('KrParksSource', () => {
  const region = (id: string, b: { west: number; south: number; east: number; north: number }): Region => ({
    id,
    core: b,
    padded: b,
  });

  it('serves only the parks whose box meets the region', async () => {
    const { parks, stats } = await convertKrParks({ dir: FIXTURES });
    const file = encodeKrParksFile(parks, stats, DEFAULT_KR_PARK_GROUPS, 200);
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'kr-parks-'));
    const path = join(dir, 'parks.json');
    await writeFile(path, JSON.stringify(file));
    try {
      const source = new KrParksSource({ file: path });
      expect(source.provides).toEqual(['parks']);
      expect(source.attribution).toEqual([KR_PARKS_ATTRIBUTION]);

      const namsan = await source.load(region('namsan', { west: 126.94, south: 37.57, east: 126.955, north: 37.585 }));
      expect(namsan.parks.map((p) => p.name)).toContain('남산공원');
      expect(namsan.parks.map((p) => p.name)).not.toContain('보라매공원');
      // Nothing but parks: the routing keeps the other six layers on OSM.
      for (const layer of LAYER_NAMES) {
        if (layer !== 'parks') expect(namsan[layer]).toHaveLength(0);
      }

      const busan = await source.load(region('busan', { west: 129, south: 35.1, east: 129.1, north: 35.2 }));
      expect(busan.parks).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a file that is not a converted park file', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'kr-parks-'));
    const path = join(dir, 'bad.json');
    await writeFile(path, JSON.stringify({ format: 'geojson', parks: [] }));
    try {
      await expect(new KrParksSource({ file: path }).prepare()).rejects.toThrow(/maprama-kr-parks-1/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('attribution when parks change hands', () => {
  /** A stand-in for the OSM source: provides everything, one attribution line. */
  const osm: TileSource = {
    id: 'osm',
    attribution: ['© OpenStreetMap contributors'],
    provides: LAYER_NAMES,
    load: async (): Promise<GeoBundle> => {
      throw new Error('not used');
    },
  };
  const kr: TileSource = {
    id: 'kr-parks',
    attribution: [KR_PARKS_ATTRIBUTION],
    provides: ['parks'] as LayerName[],
    load: async (): Promise<GeoBundle> => {
      throw new Error('not used');
    },
  };
  const allOsm = Object.fromEntries(LAYER_NAMES.map((l) => [l, 'osm'])) as LayerRouting;
  const swapped: LayerRouting = { ...allOsm, parks: 'kr-parks' };

  it('adds the 공공누리 line to the table only when parks are routed to it', () => {
    expect(attributionTable([osm, kr], allOsm)).toEqual(['© OpenStreetMap contributors']);
    expect(attributionTable([osm, kr], swapped)).toEqual(['© OpenStreetMap contributors', KR_PARKS_ATTRIBUTION]);
  });

  it('separates a tile that got a Korean park from one that did not', () => {
    const indices = attributionIndices([osm, kr], swapped);
    // A tile with buildings and roads but no park: OSM only.
    expect(tileAttribution(['osm'], indices)).toEqual([0]);
    // A tile that also got a park: both lines, so 공공누리 출처표시 is satisfied
    // exactly where the obligation arises.
    expect(tileAttribution(['osm', 'kr-parks'], indices)).toEqual([0, 1]);
    // A tile with nothing but a park — offshore reclamation, say.
    expect(tileAttribution(['kr-parks'], indices)).toEqual([1]);
  });
});
