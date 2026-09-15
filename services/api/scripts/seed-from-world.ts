/**
 * Usage: tsx scripts/seed-from-world.ts <world.json> [--region <name>] [--out <seed.sql>]
 *
 * Emits D1 SQL that upserts the world's POIs and stations into `places` (+ FTS)
 * and its stations into `transit_stations`. Apply with:
 *   wrangler d1 execute DB --local --file seed.sql
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { validateWorldData, type WorldData } from '@maprama/protocol';
import { inlineSql, placeUpsert, stationUpsert } from '../src/adapters/d1/statements.js';
import { seedFromWorld } from '../src/seed/world.js';

export function worldSeedSql(world: WorldData, region: string): string {
  const { places, stations } = seedFromWorld(world, region);
  const lines = [
    `-- Seed generated from world "${world.name.replace(/\n/g, ' ')}" (region ${region}): ${places.length} places, ${stations.length} stations.`,
    ...stations.map((s) => inlineSql(stationUpsert(s))),
    ...places.flatMap((p) => placeUpsert(p).map(inlineSql)),
  ];
  return `${lines.join('\n')}\n`;
}

function main(argv: string[]): void {
  const args = [...argv];
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const region = opt('--region');
  const out = opt('--out');
  const file = args[0];
  if (!file) {
    console.error('Usage: seed-from-world <world.json> [--region <name>] [--out <seed.sql>]');
    process.exit(2);
  }
  const world: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const valid = validateWorldData(world);
  if (!valid.ok) {
    console.error(`Invalid WorldData: ${valid.error}`);
    process.exit(1);
  }
  const name = (region ?? basename(file).replace(/\.world\.json$|\.json$/, '')).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  const sql = worldSeedSql(world as WorldData, name);
  if (out) writeFileSync(out, sql);
  else process.stdout.write(sql);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
