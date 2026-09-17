/**
 * `maprama-tiles` — the command line.
 *
 * ```sh
 * maprama-tiles survey --pbf korea.osm.pbf --work .work
 * maprama-tiles build  --pbf korea.osm.pbf --work .work --out korea.pmtiles
 * maprama-tiles verify korea.pmtiles
 * maprama-tiles inspect korea.pmtiles --at 127.027,37.497
 * maprama-tiles water korea.pmtiles --at 126.995,37.527
 * ```
 *
 * `build` resumes: point it at a work directory that already has shards and it
 * picks up where it stopped.
 *
 * @module
 */

import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { surveyPbfNodes } from '@maprama/osm';
import { buildArchive, clearWork, DEFAULT_BUFFER, DEFAULT_EXTENT, DEFAULT_PROFILES } from './build.js';
import { DEFAULT_PAD_DEG } from './chunks.js';
import { isSyntheticEdge } from './geometry.js';
import { tileGroundMeters, tileOf, tileUnitMeters } from './mercator.js';
import {
  DEFAULT_KR_PARK_GROUPS,
  DEFAULT_KR_PARK_MIN_AREA_M2,
  KR_PARKS_ATTRIBUTION,
  KR_PARK_GROUPS,
  KrParksSource,
  convertKrParks,
  encodeKrParksFile,
  type KrParkGroup,
} from './kr-parks.js';
import { OsmPbfSource } from './osm-source.js';
import { openArchive, readTile } from './reader.js';
import { DEFAULT_LAYER_ROUTING } from './sources.js';
import { LAYER_NAMES, type LayerName } from './types.js';
import type { GeoBounds } from './mercator.js';

/** Default area: the South Korea Geofabrik extract's footprint, rounded outwards. */
export const SOUTH_KOREA: GeoBounds = { west: 124.5, south: 32.9, east: 132.1, north: 38.7 };

const USAGE = `maprama-tiles <command> [options]

  survey  --pbf <file> --work <dir> [--chunk-zoom 10]
          One pass over the .pbf, counting nodes per chunk cell. Cached; the
          build needs it to know which chunks exist and how to batch them.

  build   --pbf <file> --work <dir> --out <file.pmtiles>
          [--name <s>] [--bounds w,s,e,n] [--chunk-zoom 10] [--node-budget 6000000]
          [--max-chunks 64] [--extent 8192] [--buffer 256] [--zooms 13,15] [--pad 0.01]
          [--kr-buildings <geojson>] [--kr-fill] [--kr-parks <file.json>] [--fresh]
          Builds the archive, resuming from --work unless --fresh.
          --kr-parks routes the parks layer to the Korean national city-planning
          dataset instead of OSM. Without it the routing is all-OSM as before.

  kr-parks --src <dir> --out <file.json>
          [--groups park,amusement] [--min-area 200] [--no-rescue]
          One-off conversion of the unpacked 토지이음 (도시계획)시설정보 UQ153
          shapefiles (EPSG:5174, CP949) into the file --kr-parks reads.
          Groups: plaza(UQT1) park(UQT2) green(UQT3) amusement(UQT4) openspace(UQT5).

  verify  <archive.pmtiles>
          Reads the archive back with the official pmtiles package: header,
          metadata, leaf directories, and a decode of sampled tiles.

  inspect <archive.pmtiles> [--at <lng,lat>] [--tile <z/x/y>] [--zoom 15]
          Decodes one tile and prints what is in it.

  water   <archive.pmtiles> --at <lng,lat> [--zoom 15]
          Reports the synthetic (tile-boundary) edges of the water polygons in
          the tile at that point and its east/south neighbours. Use it on a
          river crossing a tile boundary.
`;

interface Args {
  _: string[];
  [key: string]: string | boolean | string[];
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

const str = (args: Args, key: string): string | undefined =>
  typeof args[key] === 'string' ? (args[key] as string) : undefined;
const num = (args: Args, key: string, fallback: number): number => {
  const v = str(args, key);
  return v === undefined ? fallback : Number(v);
};

function required(args: Args, key: string): string {
  const v = str(args, key);
  if (v === undefined) throw new Error(`--${key} is required`);
  return v;
}

function parseBounds(text: string): GeoBounds {
  const parts = text.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`--bounds must be "west,south,east,north" (got "${text}")`);
  }
  return { west: parts[0]!, south: parts[1]!, east: parts[2]!, north: parts[3]! };
}

function parseAt(text: string): { lng: number; lat: number } {
  const parts = text.split(',').map(Number);
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`--at must be "lng,lat" (got "${text}")`);
  }
  return { lng: parts[0]!, lat: parts[1]! };
}

const surveyPath = (workDir: string, z: number): string => join(workDir, `survey.z${z}.json`);

async function loadSurvey(workDir: string, z: number): Promise<Map<string, number> | undefined> {
  const path = surveyPath(workDir, z);
  try {
    await stat(path);
  } catch {
    return undefined;
  }
  return new Map(Object.entries(JSON.parse(await readFile(path, 'utf8')) as Record<string, number>));
}

async function runSurvey(args: Args, log: (m: string) => void): Promise<Map<string, number>> {
  const pbf = required(args, 'pbf');
  const workDir = required(args, 'work');
  const z = num(args, 'chunk-zoom', 10);
  await mkdir(workDir, { recursive: true });
  const cached = args['fresh'] ? undefined : await loadSurvey(workDir, z);
  if (cached) {
    log(`survey: reusing ${surveyPath(workDir, z)} (${cached.size} non-empty cells)`);
    return cached;
  }
  const counts = await surveyPbfNodes(pbf, z, { log });
  await writeFile(surveyPath(workDir, z), JSON.stringify(Object.fromEntries([...counts].sort())));
  log(`survey: wrote ${surveyPath(workDir, z)}`);
  return counts;
}

async function cmdBuild(args: Args, log: (m: string) => void): Promise<void> {
  const pbf = required(args, 'pbf');
  const workDir = required(args, 'work');
  const out = required(args, 'out');
  const chunkZoom = num(args, 'chunk-zoom', 10);
  if (args['fresh']) await clearWork(workDir);
  const survey = await runSurvey({ ...args, fresh: false } as Args, log);

  const zooms = str(args, 'zooms')?.split(',').map(Number);
  const profiles = zooms
    ? zooms.map((zoom) => ({ zoom, name: zoom >= 15 ? ('detail' as const) : ('overview' as const) }))
    : DEFAULT_PROFILES;

  const krPath = str(args, 'kr-buildings');
  const source = new OsmPbfSource({
    file: pbf,
    log,
    ...(krPath ? { krBuildings: JSON.parse(await readFile(krPath, 'utf8')) as unknown } : {}),
    ...(args['kr-fill'] ? { krFillMissing: true } : {}),
  });

  // The one place a layer changes hands. Everything downstream — tiler, encoder,
  // archive writer, attribution table — reads the routing and needs no edit.
  const krParksPath = str(args, 'kr-parks');
  const sources = krParksPath ? [source, new KrParksSource({ file: krParksPath, log })] : [source];
  const routing = krParksPath ? { ...DEFAULT_LAYER_ROUTING, parks: 'kr-parks' } : DEFAULT_LAYER_ROUTING;

  let peakRss = 0;
  const sampler = setInterval(() => {
    const rss = process.memoryUsage.rss();
    if (rss > peakRss) peakRss = rss;
  }, 500);
  sampler.unref();

  const report = await buildArchive({
    workDir,
    out,
    name: str(args, 'name') ?? 'South Korea',
    bounds: str(args, 'bounds') ? parseBounds(str(args, 'bounds')!) : SOUTH_KOREA,
    sources,
    routing,
    survey,
    profiles,
    chunkZoom,
    extent: num(args, 'extent', DEFAULT_EXTENT),
    buffer: num(args, 'buffer', DEFAULT_BUFFER),
    padDeg: num(args, 'pad', DEFAULT_PAD_DEG),
    nodeBudget: num(args, 'node-budget', 6_000_000),
    maxChunksPerBatch: num(args, 'max-chunks', 64),
    log,
  });
  clearInterval(sampler);

  const mb = (n: number): string => (n / 2 ** 20).toFixed(1);
  log('');
  log(`archive        ${out}`);
  log(`  bytes        ${report.archive.bytes.toLocaleString()} (${mb(report.archive.bytes)} MiB)`);
  log(`  tiles        ${report.archive.addressedTiles.toLocaleString()} addressed, ${report.archive.uniqueContents.toLocaleString()} unique bodies`);
  for (const z of Object.keys(report.tilesPerZoom).map(Number).sort((a, b) => a - b)) {
    const tiles = report.tilesPerZoom[z]!;
    const bytes = report.bytesPerZoom[z]!;
    log(`  z${z}          ${tiles.toLocaleString()} tiles, ${mb(bytes)} MiB, avg ${(bytes / tiles / 1024).toFixed(1)} KB`);
  }
  log(`  directories  root ${report.archive.rootDirectoryBytes} B, ${report.archive.leafCount} leaves / ${mb(report.archive.leafDirectoryBytes)} MiB (${report.archive.leafSize} entries each)`);
  log(`  chunks       ${report.chunksPlanned} planned, ${report.chunksBuilt} built, ${report.chunksSkipped} resumed, ${report.batches} batches`);
  log(`  overhang     ${report.buildingOverflowUnits} units (${(report.buildingOverflowUnits * tileUnitMeters(15, 37.5, num(args, 'extent', DEFAULT_EXTENT))).toFixed(1)} m at z15)`);
  log(`  attribution  ${JSON.stringify(report.attribution)}`);
  log(`  elapsed      ${(report.seconds / 60).toFixed(1)} min`);
  log(`  peak rss     ${mb(peakRss)} MiB`);
}

async function cmdKrParks(args: Args, log: (m: string) => void): Promise<void> {
  const src = required(args, 'src');
  const out = required(args, 'out');
  const groupNames = (str(args, 'groups') ?? DEFAULT_KR_PARK_GROUPS.join(',')).split(',').map((s) => s.trim());
  for (const g of groupNames) {
    if (!(g in KR_PARK_GROUPS)) {
      throw new Error(`--groups: unknown group "${g}" (known: ${Object.keys(KR_PARK_GROUPS).join(', ')})`);
    }
  }
  const groups = groupNames as KrParkGroup[];
  const minAreaM2 = num(args, 'min-area', DEFAULT_KR_PARK_MIN_AREA_M2);
  const { parks, stats } = await convertKrParks({
    dir: src,
    groups,
    minAreaM2,
    rescueByName: !args['no-rescue'],
    log: (m) => {
      if (args['verbose']) log(m);
    },
  });
  await writeFile(out, JSON.stringify(encodeKrParksFile(parks, stats, groups, minAreaM2)));
  const bytes = (await stat(out)).size;
  log(`kr-parks   ${out}  (${(bytes / 2 ** 20).toFixed(1)} MiB)`);
  log(`  groups     ${groups.join(',')}  min-area ${minAreaM2} m²`);
  log(`  read       ${stats.files} shapefiles, ${stats.records.toLocaleString()} records`);
  log(`  selected   ${stats.matched.toLocaleString()} by code + ${stats.rescued.toLocaleString()} rescued by name`);
  log(`  rings      ${stats.rings.toLocaleString()} outer (${stats.droppedHoles.toLocaleString()} holes dropped)`);
  log(`  dropped    ${stats.droppedSmall.toLocaleString()} under ${minAreaM2} m², ${stats.droppedDuplicate.toLocaleString()} duplicates`);
  log(`  kept       ${stats.kept.toLocaleString()} polygons, ${stats.areaKm2.toFixed(1)} km²`);
  log(`  attribution ${JSON.stringify(KR_PARKS_ATTRIBUTION)}`);
}

async function cmdVerify(args: Args, log: (m: string) => void): Promise<void> {
  const path = args._[1];
  if (!path) throw new Error('verify needs an archive path');
  const archive = openArchive(path);
  const header = await archive.getHeader();
  const metadata = (await archive.getMetadata()) as Record<string, unknown>;
  log(`header    specVersion=${header.specVersion} tileType=${header.tileType} tileCompression=${header.tileCompression}`);
  log(`          minZoom=${header.minZoom} maxZoom=${header.maxZoom} clustered=${header.clustered}`);
  log(`          addressedTiles=${header.numAddressedTiles.toLocaleString()} tileEntries=${header.numTileEntries.toLocaleString()} tileContents=${header.numTileContents.toLocaleString()}`);
  const leafBytes = header.leafDirectoryLength ?? 0;
  log(`          root=${header.rootDirectoryLength} B  leaves=${leafBytes.toLocaleString()} B  metadata=${header.jsonMetadataLength} B`);
  log(`          bounds=[${header.minLon}, ${header.minLat}, ${header.maxLon}, ${header.maxLat}]`);
  log(`metadata  ${JSON.stringify(metadata)}`);
  if (leafBytes === 0) log('WARNING: this archive has no leaf directories');
  if (header.rootDirectoryLength + 127 + header.jsonMetadataLength > 16384) {
    log('WARNING: header + root + metadata exceed 16 KiB — a cold start will need extra requests');
  }

  // Sample tiles by sweeping the archive's own bounds rather than by walking a
  // tile range: most of a national grid is empty, so a range walk finds nothing.
  let checked = 0;
  let failed = 0;
  let misses = 0;
  const layerTotals: Record<string, number> = {};
  const steps = 60;
  for (const z of [header.minZoom, header.maxZoom]) {
    const seen = new Set<string>();
    for (let i = 0; i < steps && checked < 128; i++) {
      for (let j = 0; j < steps && checked < 128; j++) {
        const lng = header.minLon + ((header.maxLon - header.minLon) * (i + 0.5)) / steps;
        const lat = header.minLat + ((header.maxLat - header.minLat) * (j + 0.5)) / steps;
        const { x, y } = tileOf(lng, lat, z);
        const key = `${z}/${x}/${y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let tile;
        try {
          tile = await readTile(archive, z, x, y);
        } catch (e) {
          failed++;
          log(`  ${key}: DECODE FAILED ${(e as Error).message}`);
          continue;
        }
        if (!tile) {
          misses++;
          continue;
        }
        checked++;
        for (const name of LAYER_NAMES) layerTotals[name] = (layerTotals[name] ?? 0) + tile.layers[name].length;
        if (tile.extent !== DEFAULT_EXTENT && tile.extent <= 0) failed++;
        if (tile.attribution.length === 0) {
          failed++;
          log(`  ${key}: no attribution indices`);
        }
      }
    }
  }
  log(`tiles     decoded ${checked} sampled tiles (${misses} probes hit no stored tile), ${failed} problems`);
  log(`          features ${JSON.stringify(layerTotals)}`);
  if (failed > 0) process.exitCode = 1;
}

async function cmdInspect(args: Args, log: (m: string) => void): Promise<void> {
  const path = args._[1];
  if (!path) throw new Error('inspect needs an archive path');
  const archive = openArchive(path);
  const header = await archive.getHeader();
  const z = num(args, 'zoom', header.maxZoom);
  let x: number;
  let y: number;
  const tileArg = str(args, 'tile');
  if (tileArg) {
    const [tz, tx, ty] = tileArg.split('/').map(Number);
    if (tz === undefined || tx === undefined || ty === undefined) throw new Error('--tile must be "z/x/y"');
    return printTile(archive, tz, tx, ty, log);
  }
  const at = parseAt(required(args, 'at'));
  ({ x, y } = tileOf(at.lng, at.lat, z));
  return printTile(archive, z, x, y, log);
}

async function printTile(
  archive: ReturnType<typeof openArchive>,
  z: number,
  x: number,
  y: number,
  log: (m: string) => void,
): Promise<void> {
  const tile = await readTile(archive, z, x, y);
  if (!tile) {
    log(`${z}/${x}/${y}: not in the archive (empty tiles are not stored)`);
    return;
  }
  const metadata = (await archive.getMetadata()) as { attribution?: string[] };
  log(`${z}/${x}/${y}  extent=${tile.extent} buffer=${tile.buffer} clipped=${tile.clipped}`);
  log(`  ground     ${tileGroundMeters(z, 37.5).toFixed(0)} m per edge, ${tileUnitMeters(z, 37.5, tile.extent).toFixed(3)} m per unit`);
  log(`  attribution ${JSON.stringify(tile.attribution.map((i) => metadata.attribution?.[i] ?? `#${i}`))}`);
  for (const name of LAYER_NAMES) {
    const features = tile.layers[name];
    if (features.length === 0) continue;
    log(`  ${name.padEnd(10)} ${String(features.length).padStart(5)}  ${sample(name, features)}`);
  }
}

function sample(name: LayerName, features: readonly unknown[]): string {
  const first = features.slice(0, 3).map((f) => {
    const r = f as Record<string, unknown>;
    if (name === 'buildings') return `${String(r['name'] ?? r['id'])}(${Number(r['heightDm']) / 10}m)`;
    if (name === 'roads') return `${String(r['name'] ?? r['cls'])}`;
    if (name === 'pois' || name === 'stations' || name === 'districts') return String(r['name']);
    return `${(r['poly'] as unknown[] | undefined)?.length ?? 0}pts`;
  });
  return first.join(', ');
}

async function cmdWater(args: Args, log: (m: string) => void): Promise<void> {
  const path = args._[1];
  if (!path) throw new Error('water needs an archive path');
  const archive = openArchive(path);
  const header = await archive.getHeader();
  const z = num(args, 'zoom', header.maxZoom);
  const at = parseAt(required(args, 'at'));
  const home = tileOf(at.lng, at.lat, z);

  log(`water edges around ${at.lng},${at.lat} at z${z}`);
  log('');
  log('  tile             ring  edges  synthetic(clip ±buffer)  literal(0/extent)');
  let totalClip = 0;
  let totalLiteral = 0;
  for (const [dx, dy] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const) {
    const x = home.x + dx;
    const y = home.y + dy;
    const tile = await readTile(archive, z, x, y);
    if (!tile) {
      log(`  ${z}/${x}/${y}  (not stored)`);
      continue;
    }
    tile.layers.water.forEach((w, i) => {
      let clip = 0;
      let literal = 0;
      for (let a = 0, b = w.poly.length - 1; a < w.poly.length; b = a++) {
        const p = w.poly[b]!;
        const q = w.poly[a]!;
        if (isSyntheticEdge(p, q, tile.extent, tile.buffer)) clip++;
        if (isSyntheticEdge(p, q, tile.extent, 0)) literal++;
      }
      totalClip += clip;
      totalLiteral += literal;
      log(
        `  ${`${z}/${x}/${y}`.padEnd(16)} ${String(i).padStart(4)} ${String(w.poly.length).padStart(6)} ${String(clip).padStart(22)} ${String(literal).padStart(17)}`,
      );
    });
  }
  log('');
  log(`  totals: ${totalClip} edges excluded by the clip-rectangle rule, ${totalLiteral} by the literal 0/extent rule.`);
  log('  The clip rectangle is [-buffer, extent+buffer], so edges created by the clip lie there,');
  log('  not on 0/extent. A renderer testing 0/extent would build a bank across the river.');
}

/** Runs the CLI. Returns the process exit code. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const command = args._[0];
  const log = (m: string): void => {
    process.stderr.write(`${m}\n`);
  };
  if (!command || command === 'help' || args['help']) {
    process.stdout.write(USAGE);
    return 0;
  }
  try {
    switch (command) {
      case 'survey':
        await runSurvey(args, log);
        break;
      case 'build':
        await cmdBuild(args, log);
        break;
      case 'kr-parks':
        await cmdKrParks(args, log);
        break;
      case 'verify':
        await cmdVerify(args, log);
        break;
      case 'inspect':
        await cmdInspect(args, log);
        break;
      case 'water':
        await cmdWater(args, log);
        break;
      default:
        process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    process.stderr.write(`maprama-tiles: ${(e as Error).message}\n`);
    return 1;
  }
  return typeof process.exitCode === 'number' ? process.exitCode : 0;
}
