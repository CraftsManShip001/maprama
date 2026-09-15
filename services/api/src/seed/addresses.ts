/**
 * Parser for the Korean road-name address DB (도로명주소 DB) text exports,
 * producing `address` places for search and reverse geocoding.
 *
 * Input: one record per line, `|`-delimited (the official distribution format)
 * or `,`-delimited CSV (double-quoted fields allowed). Official files are CP949;
 * pass `encoding: 'euc-kr'` when decoding them.
 *
 * Columns are resolved in this order:
 * 1. A header line containing Korean column names (any order, extra columns ignored).
 * 2. Otherwise the default positional layout {@link DEFAULT_COLUMNS}
 *    (the "위치정보요약DB" / building-entrance layout, 18 columns).
 *
 * Required columns: 시도명, 시군구명, 도로명, 건물본번, X좌표, Y좌표.
 * Optional: 도로명코드, 지하여부, 건물부번, 건물명, 읍면동명, 우편번호, 도로명주소관리번호.
 * Coordinates are UTM-K (EPSG:5179) metres by default, or WGS84 degrees with `crs: 'EPSG:4326'`.
 */
import type { Place } from '../deps.js';
import { utmkToLngLat } from './utmk.js';

/** Default positional layout (1-based column numbers in the documentation, 0-based here). */
export const DEFAULT_COLUMNS = [
  '시군구코드',
  '출입구일련번호',
  '법정동코드',
  '시도명',
  '시군구명',
  '읍면동명',
  '도로명코드',
  '도로명',
  '지하여부',
  '건물본번',
  '건물부번',
  '건물명',
  '우편번호',
  '건물용도분류',
  '건물군여부',
  '관할행정동',
  'X좌표',
  'Y좌표',
] as const;

const REQUIRED = ['시도명', '시군구명', '도로명', '건물본번', 'X좌표', 'Y좌표'] as const;

export interface AddressImportOptions {
  crs?: 'EPSG:5179' | 'EPSG:4326';
}

export interface AddressImportResult {
  places: Place[];
  skipped: { line: number; reason: string }[];
}

function splitLine(line: string, delimiter: string): string[] {
  if (delimiter === '|') return line.split('|').map((s) => s.trim());
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Parses address DB text into `address` places. */
export function parseAddressDb(text: string, opts: AddressImportOptions = {}): AddressImportResult {
  const crs = opts.crs ?? 'EPSG:5179';
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const firstData = lines.find((l) => l.trim().length > 0) ?? '';
  const delimiter = firstData.includes('|') ? '|' : ',';

  let columns: string[] = [...DEFAULT_COLUMNS];
  let start = 0;
  const firstCells = splitLine(firstData, delimiter);
  if (firstCells.includes('시도명') || firstCells.includes('도로명')) {
    columns = firstCells;
    start = lines.indexOf(firstData) + 1;
  }
  for (const r of REQUIRED) if (!columns.includes(r)) throw new Error(`Address DB header is missing required column "${r}"`);
  const idx = (name: string): number => columns.indexOf(name);

  const places: Place[] = [];
  const skipped: { line: number; reason: string }[] = [];
  const seen = new Set<string>();
  for (let i = start; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw.trim()) continue;
    const cells = splitLine(raw, delimiter);
    const get = (name: string): string => {
      const j = idx(name);
      return j >= 0 ? (cells[j] ?? '').trim() : '';
    };
    const sido = get('시도명');
    const sigungu = get('시군구명');
    const road = get('도로명');
    const main = get('건물본번');
    const sub = get('건물부번');
    const underground = get('지하여부') === '1';
    const xs = get('X좌표');
    const ys = get('Y좌표');
    if (!sido || !road || !/^\d+$/.test(main)) {
      skipped.push({ line: i + 1, reason: 'missing address fields' });
      continue;
    }
    const x = Number(xs);
    const y = Number(ys);
    if (!xs || !ys || !Number.isFinite(x) || !Number.isFinite(y)) {
      skipped.push({ line: i + 1, reason: 'missing coordinates' });
      continue;
    }
    const coord = crs === 'EPSG:5179' ? utmkToLngLat(x, y) : { lng: x, lat: y };
    if (coord.lng < 124 || coord.lng > 132 || coord.lat < 33 || coord.lat > 39.5) {
      skipped.push({ line: i + 1, reason: 'coordinates outside Korea' });
      continue;
    }
    const number = `${underground ? '지하 ' : ''}${Number(main)}${sub && sub !== '0' ? `-${Number(sub)}` : ''}`;
    const address = [sido, sigungu, road, number].filter(Boolean).join(' ');
    const building = get('건물명');
    const roadCode = get('도로명코드');
    const mgmt = get('도로명주소관리번호');
    const id = `addr:${mgmt || `${roadCode || `${sido}${sigungu}${road}`}-${underground ? 1 : 0}-${Number(main)}-${Number(sub || '0')}`}`;
    if (seen.has(id)) continue;
    seen.add(id);
    places.push({
      id,
      kind: 'address',
      name: building || `${road} ${number}`,
      address,
      category: get('우편번호') || null,
      coordinate: { lng: Math.round(coord.lng * 1e7) / 1e7, lat: Math.round(coord.lat * 1e7) / 1e7 },
      source: 'juso',
    });
  }
  return { places, skipped };
}
