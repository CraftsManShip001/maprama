/**
 * Write statements shared by the D1 adapters and the SQL seed scripts, so a
 * seeded database is byte-for-byte what the adapters would have written.
 */
import type { ApiKeyRecord, Place, TransitLineInput, TransitStationInput } from '../../deps.js';
import { indexTokens } from '../../search/normalize.js';

export type SqlValue = string | number | null;

export interface Stmt {
  sql: string;
  params: SqlValue[];
}

export function placeUpsert(p: Place): Stmt[] {
  return [
    {
      sql:
        'INSERT INTO places (id, kind, name, address, category, lng, lat, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, name = excluded.name, address = excluded.address, ' +
        'category = excluded.category, lng = excluded.lng, lat = excluded.lat, source = excluded.source',
      params: [p.id, p.kind, p.name, p.address ?? null, p.category ?? null, p.coordinate.lng, p.coordinate.lat, p.source ?? null],
    },
    { sql: 'DELETE FROM places_fts WHERE rowid = (SELECT pk FROM places WHERE id = ?)', params: [p.id] },
    { sql: 'INSERT INTO places_fts (rowid, grams) SELECT pk, ? FROM places WHERE id = ?', params: [indexTokens(p.name, p.address).join(' '), p.id] },
  ];
}

export function stationUpsert(s: TransitStationInput): Stmt {
  return {
    sql: 'INSERT INTO transit_stations (id, name, lng, lat) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, lng = excluded.lng, lat = excluded.lat',
    params: [s.id, s.name, s.coordinate.lng, s.coordinate.lat],
  };
}

export function lineUpsert(line: TransitLineInput): Stmt[] {
  return [
    {
      sql: 'INSERT INTO transit_lines (id, name, color) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, color = excluded.color',
      params: [line.id, line.name, line.color],
    },
    { sql: 'DELETE FROM transit_line_stations WHERE line_id = ?', params: [line.id] },
    ...line.stationIds.map((stationId, seq) => ({
      sql: 'INSERT INTO transit_line_stations (line_id, seq, station_id) VALUES (?, ?, ?)',
      params: [line.id, seq, stationId],
    })),
  ];
}

export function apiKeyInsert(k: ApiKeyRecord): Stmt {
  return {
    sql: 'INSERT INTO api_keys (id, key_hash, app_id, plan, monthly_quota, role, label, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    params: [k.id, k.keyHash, k.appId, k.plan, k.monthlyQuota, k.role, k.label ?? null, k.createdAt, k.revokedAt ?? null],
  };
}

/** SQL literal for a value (strings single-quoted with quotes doubled). */
export function sqlLiteral(v: SqlValue): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new RangeError('sqlLiteral: non-finite number');
    return String(v);
  }
  return `'${v.replace(/'/g, "''")}'`;
}

/** Inlines parameters into a statement for `wrangler d1 execute --file`. Statement SQL must not contain `?` literals. */
export function inlineSql(stmt: Stmt): string {
  let i = 0;
  const sql = stmt.sql.replace(/\?/g, () => {
    if (i >= stmt.params.length) throw new RangeError('inlineSql: too few parameters');
    return sqlLiteral(stmt.params[i++]!);
  });
  if (i !== stmt.params.length) throw new RangeError('inlineSql: too many parameters');
  return `${sql};`;
}
