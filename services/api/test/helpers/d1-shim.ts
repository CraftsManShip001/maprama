/**
 * A minimal Cloudflare D1 API shim over Node's built-in `node:sqlite`
 * (SQLite with FTS5 and JSON1), so the real D1 adapters and the migration SQL
 * run in tests without a Cloudflare account. Implements only what the adapters
 * use: prepare/bind/first/all/run and batch.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { D1Database } from '@cloudflare/workers-types/index';

type Row = Record<string, unknown>;

class ShimStatement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    readonly params: SQLInputValue[] = [],
  ) {}

  bind(...params: unknown[]): ShimStatement {
    return new ShimStatement(
      this.db,
      this.sql,
      params.map((p) => (p === undefined ? null : (p as SQLInputValue))),
    );
  }

  async first<T = Row>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params) as Row | undefined;
    if (!row) return null;
    return (column ? row[column] : { ...row }) as T;
  }

  async all<T = Row>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    const rows = this.db.prepare(this.sql).all(...this.params) as Row[];
    return { results: rows.map((r) => ({ ...r }) as T), success: true, meta: {} };
  }

  runSync(): { success: true; results: []; meta: { changes: number; last_row_id: number } } {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }

  async run(): Promise<ReturnType<ShimStatement['runSync']>> {
    return this.runSync();
  }
}

class ShimD1 {
  constructor(readonly sqlite: DatabaseSync) {}

  prepare(sql: string): ShimStatement {
    return new ShimStatement(this.sqlite, sql);
  }

  async batch(statements: ShimStatement[]): Promise<ReturnType<ShimStatement['runSync']>[]> {
    this.sqlite.exec('BEGIN');
    try {
      const out = statements.map((s) => s.runSync());
      this.sqlite.exec('COMMIT');
      return out;
    } catch (err) {
      this.sqlite.exec('ROLLBACK');
      throw err;
    }
  }

  async exec(sql: string): Promise<void> {
    this.sqlite.exec(sql);
  }
}

export const MIGRATION_PATH = fileURLToPath(new URL('../../migrations/0001_init.sql', import.meta.url));

/** Creates an in-memory SQLite database with the migration applied, exposed through the D1 API. */
export function createTestD1(): { d1: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(MIGRATION_PATH, 'utf8'));
  return { d1: new ShimD1(sqlite) as unknown as D1Database, sqlite };
}
