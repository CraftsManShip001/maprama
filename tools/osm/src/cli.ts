/**
 * `maprama-osm` command line interface.
 *
 * @module
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { validateWorldData, type LngLat } from '@maprama/protocol';
import { buildWorldWithStats, stringifyWorld, type BuildWorldOptions } from './build.js';
import { fetchOverpass, parseBBox } from './overpass.js';
import { PACKAGE_ROOT, SAMPLES } from './samples.js';
import type { OverpassResponse } from './types.js';

/** Output sinks (injectable for tests). */
export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const defaultIO: CliIO = {
  stdout: (t) => process.stdout.write(`${t}\n`),
  stderr: (t) => process.stderr.write(`${t}\n`),
};

/** Size above which the CLI warns that a world file is getting heavy. */
export const WORLD_SIZE_WARN_BYTES = 3 * 1024 * 1024;

export const USAGE = `maprama-osm: build Maprama WorldData from OpenStreetMap

Usage:
  maprama-osm fetch --bbox s,w,n,e --out raw.json [--endpoint url]... [--no-cache] [--timeout 90]
  maprama-osm build --raw raw.json --out world.json --name <name>
                    [--bbox s,w,n,e] [--origin lat,lng] [--unit-meters 8]
                    [--kr-buildings kr.geojson] [--simplify-meters 0.5]
                    [--precision 2] [--include-sidewalks]
  maprama-osm sample <${Object.keys(SAMPLES).join('|')}> [--out world.json] [--raw raw.json]
                    [--endpoint url]... [--no-cache] [--kr-buildings kr.geojson]
  maprama-osm help

Environment:
  MAPRAMA_OVERPASS_ENDPOINT  comma-separated Overpass endpoints (overrides defaults)
  MAPRAMA_OSM_USER_AGENT     User-Agent sent to Overpass`;

class UsageError extends Error {}

function num(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number, got "${value}"`);
  return n;
}

function parseLatLng(text: string): LngLat {
  const parts = text.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) {
    throw new UsageError(`invalid --origin "${text}" (expected lat,lng)`);
  }
  return { lat: parts[0]!, lng: parts[1]! };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const CACHE_DIR = join(PACKAGE_ROOT, '.cache');

const fetchOptions = {
  endpoint: { type: 'string', multiple: true },
  'no-cache': { type: 'boolean' },
  timeout: { type: 'string' },
} as const;

const buildOptions = {
  origin: { type: 'string' },
  'unit-meters': { type: 'string' },
  'kr-buildings': { type: 'string' },
  'simplify-meters': { type: 'string' },
  precision: { type: 'string' },
  'include-sidewalks': { type: 'boolean' },
} as const;

interface BuildFlags {
  origin?: string;
  'unit-meters'?: string;
  'kr-buildings'?: string;
  'simplify-meters'?: string;
  precision?: string;
  'include-sidewalks'?: boolean;
}

async function toBuildOptions(flags: BuildFlags, name: string): Promise<BuildWorldOptions> {
  return {
    name,
    origin: flags.origin ? parseLatLng(flags.origin) : undefined,
    unitMeters: num('unit-meters', flags['unit-meters']),
    simplifyMeters: num('simplify-meters', flags['simplify-meters']),
    precision: num('precision', flags.precision),
    includeSidewalks: flags['include-sidewalks'] ?? false,
    krBuildings: flags['kr-buildings'] ? await readJson(resolve(flags['kr-buildings'])) : undefined,
  };
}

async function runBuild(raw: OverpassResponse, out: string, options: BuildWorldOptions, io: CliIO): Promise<void> {
  const { world, stats } = buildWorldWithStats(raw, options);
  const text = stringifyWorld(world);
  await writeText(out, text);
  const bytes = Buffer.byteLength(text);
  const check = validateWorldData(JSON.parse(text));
  io.stdout(JSON.stringify({ out, bytes, valid: check.ok, ...stats }, null, 2));
  if (!check.ok) throw new Error(`written world failed validation: ${check.error}`);
  if (bytes > WORLD_SIZE_WARN_BYTES) {
    io.stderr(`warning: ${out} is ${(bytes / 1048576).toFixed(2)} MB; consider --simplify-meters 1 or a smaller bbox`);
  }
}

/** Runs the CLI; resolves to the process exit code. */
export async function main(argv: string[], io: CliIO = defaultIO): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'fetch': {
        const { values } = parseArgs({
          args: rest,
          options: { ...fetchOptions, bbox: { type: 'string' }, out: { type: 'string' } },
          strict: true,
        });
        if (!values.bbox || !values.out) throw new UsageError('fetch requires --bbox and --out');
        const bbox = parseBBox(values.bbox);
        const raw = await fetchOverpass(bbox, {
          endpoints: values.endpoint,
          cacheDir: values['no-cache'] ? null : CACHE_DIR,
          timeoutMs: (num('timeout', values.timeout) ?? 90) * 1000,
          log: io.stderr,
        });
        await writeText(resolve(values.out), JSON.stringify(raw));
        io.stdout(JSON.stringify({ out: resolve(values.out), elements: raw.elements.length }));
        return 0;
      }
      case 'build': {
        const { values } = parseArgs({
          args: rest,
          options: {
            ...buildOptions,
            raw: { type: 'string' },
            out: { type: 'string' },
            name: { type: 'string' },
            bbox: { type: 'string' },
          },
          strict: true,
        });
        if (!values.raw || !values.out || !values.name) throw new UsageError('build requires --raw, --out and --name');
        const raw = (await readJson(resolve(values.raw))) as OverpassResponse;
        const options = await toBuildOptions(values, values.name);
        if (values.bbox) options.bbox = parseBBox(values.bbox);
        await runBuild(raw, resolve(values.out), options, io);
        return 0;
      }
      case 'sample': {
        const { values, positionals } = parseArgs({
          args: rest,
          options: { ...fetchOptions, ...buildOptions, out: { type: 'string' }, raw: { type: 'string' } },
          allowPositionals: true,
          strict: true,
        });
        const id = positionals[0];
        const sample = id ? SAMPLES[id] : undefined;
        if (!id || !sample) throw new UsageError(`sample requires one of: ${Object.keys(SAMPLES).join(', ')}`);
        const out = resolve(values.out ?? join(PACKAGE_ROOT, 'samples', `${id}.world.json`));
        const rawPath = resolve(values.raw ?? join(CACHE_DIR, 'samples', `${id}.raw.json`));
        const raw = await fetchOverpass(sample.bbox, {
          endpoints: values.endpoint,
          cacheDir: values['no-cache'] ? null : CACHE_DIR,
          timeoutMs: (num('timeout', values.timeout) ?? 90) * 1000,
          log: io.stderr,
        });
        await writeText(rawPath, JSON.stringify(raw));
        io.stderr(`raw: ${rawPath} (${raw.elements.length} elements, ${(await stat(rawPath)).size} bytes)`);
        const options = await toBuildOptions(values, sample.name);
        options.bbox = sample.bbox;
        await runBuild(raw, out, options, io);
        return 0;
      }
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.stdout(USAGE);
        return command === undefined ? 1 : 0;
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    io.stderr(`maprama-osm: ${message}`);
    if (e instanceof UsageError || (e instanceof TypeError && /option|argument/i.test(message))) {
      io.stderr(USAGE);
      return 2;
    }
    return 1;
  }
}
