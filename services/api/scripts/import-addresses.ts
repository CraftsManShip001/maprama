/**
 * Usage: tsx scripts/import-addresses.ts <address-db.txt|csv> [--encoding euc-kr] [--crs EPSG:5179|EPSG:4326] [--out <places.sql>]
 *
 * Parses the Korean road-name address DB text format into `places` SQL
 * (kind `address`). See src/seed/addresses.ts for the expected columns.
 * Example fixture: test/fixtures/addresses-sample.txt (5 rows).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { inlineSql, placeUpsert } from '../src/adapters/d1/statements.js';
import { parseAddressDb } from '../src/seed/addresses.js';

function main(argv: string[]): void {
  const args = [...argv];
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const encoding = opt('--encoding') ?? 'utf-8';
  const crs = opt('--crs') ?? 'EPSG:5179';
  const out = opt('--out');
  const file = args[0];
  if (!file || (crs !== 'EPSG:5179' && crs !== 'EPSG:4326')) {
    console.error('Usage: import-addresses <file> [--encoding euc-kr] [--crs EPSG:5179|EPSG:4326] [--out <places.sql>]');
    process.exit(2);
  }
  const text = new TextDecoder(encoding).decode(readFileSync(file));
  const { places, skipped } = parseAddressDb(text, { crs });
  const sql = `-- ${places.length} address places from ${file.split('/').pop()}\n${places.flatMap((p) => placeUpsert(p).map(inlineSql)).join('\n')}\n`;
  if (out) writeFileSync(out, sql);
  else process.stdout.write(sql);
  console.error(`imported ${places.length} addresses, skipped ${skipped.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
