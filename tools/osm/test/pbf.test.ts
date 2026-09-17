import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { WorldData } from '@maprama/protocol';
import { buildWorldWithStats, type BuildWorldOptions } from '../src/build.js';
import { buildOverpassQuery } from '../src/overpass.js';
import { extractFromPbf, extractOneFromPbf, selectsPbfElement, surveyPbfNodes } from '../src/pbf.js';
import type { BBox, OverpassResponse, Tags } from '../src/types.js';

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/**
 * The bbox `fixtures/seongsu-slice.osm.pbf` was cut for, and the bbox
 * `fixtures/seongsu-slice.overpass.json` was fetched for. A block of
 * Seongsu-dong, Seoul: dense buildings (including two multipolygon relations),
 * roads that leave the box on every side, and a handful of POI nodes.
 */
const FIXTURE_BBOX: BBox = { south: 37.544, west: 127.054, north: 37.5465, east: 127.0575 };

describe('selectsPbfElement', () => {
  it('mirrors every selector line of the Overpass query', () => {
    // A tripwire. The PBF path has to pick the same features as the Overpass
    // path, and the only definition of "the same features" is this query. If a
    // line is added, removed or changed here, this fails — and whoever changed
    // it has to teach selectsPbfElement about it.
    const lines = buildOverpassQuery(FIXTURE_BBOX)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^(?:node|way|relation|nwr)\[/.test(l))
      .map((l) => l.slice(0, l.lastIndexOf('(')));
    expect(lines).toEqual([
      'way["building"]',
      'relation["building"]["type"="multipolygon"]',
      'way["highway"]',
      'way["natural"="water"]',
      'relation["natural"="water"]',
      'way["waterway"="riverbank"]',
      'relation["waterway"="riverbank"]',
      'way["water"="river"]',
      'relation["water"="river"]',
      'way["leisure"~"^(park|garden)$"]',
      'relation["leisure"~"^(park|garden)$"]',
      'way["landuse"~"^(grass|recreation_ground)$"]',
      'relation["landuse"~"^(grass|recreation_ground)$"]',
      'node["leisure"="park"]',
      'nwr["amenity"~"^(cafe|school|kindergarten)$"]',
      'nwr["shop"~"^(convenience|supermarket|music|books)$"]',
      'nwr["shop"]["name"~"LP|레코드|음반"]',
      'nwr["amenity"]["name"~"LP|레코드|음반"]',
      'node["railway"="station"]',
      'node["station"="subway"]',
      'node["place"~"^(square|neighbourhood|quarter|suburb)$"]',
      'way["place"="square"]',
    ]);
  });

  it('selects what the query selects, per element type', () => {
    // way["building"] — presence, building=no included (buildWorld drops it)
    expect(selectsPbfElement('way', { building: 'yes' })).toBe(true);
    expect(selectsPbfElement('way', { building: 'no' })).toBe(true);
    expect(selectsPbfElement('node', { building: 'yes' })).toBe(false);
    // relation["building"]["type"="multipolygon"] — both tags required
    expect(selectsPbfElement('relation', { building: 'apartments', type: 'multipolygon' })).toBe(true);
    expect(selectsPbfElement('relation', { building: 'apartments', type: 'building' })).toBe(false);
    // way["highway"]
    expect(selectsPbfElement('way', { highway: 'residential' })).toBe(true);
    expect(selectsPbfElement('relation', { highway: 'residential' })).toBe(false);
    // water
    const water: Tags[] = [{ natural: 'water' }, { waterway: 'riverbank' }, { water: 'river' }];
    for (const tags of water) {
      expect(selectsPbfElement('way', tags)).toBe(true);
      expect(selectsPbfElement('relation', tags)).toBe(true);
      expect(selectsPbfElement('node', tags)).toBe(false);
    }
    expect(selectsPbfElement('way', { waterway: 'stream' })).toBe(false);
    // green areas
    const green: Tags[] = [{ leisure: 'park' }, { leisure: 'garden' }, { landuse: 'grass' }, { landuse: 'recreation_ground' }];
    for (const tags of green) {
      expect(selectsPbfElement('way', tags)).toBe(true);
      expect(selectsPbfElement('relation', tags)).toBe(true);
    }
    expect(selectsPbfElement('way', { leisure: 'pitch' })).toBe(false);
    expect(selectsPbfElement('way', { landuse: 'residential' })).toBe(false);
    // node["leisure"="park"] only — a node in a garden is not queried
    expect(selectsPbfElement('node', { leisure: 'park' })).toBe(true);
    expect(selectsPbfElement('node', { leisure: 'garden' })).toBe(false);
    // the nwr POI selectors apply to all three types
    for (const type of ['node', 'way', 'relation'] as const) {
      expect(selectsPbfElement(type, { amenity: 'cafe' })).toBe(true);
      expect(selectsPbfElement(type, { amenity: 'school' })).toBe(true);
      expect(selectsPbfElement(type, { amenity: 'kindergarten' })).toBe(true);
      expect(selectsPbfElement(type, { amenity: 'restaurant' })).toBe(false);
      expect(selectsPbfElement(type, { shop: 'convenience' })).toBe(true);
      expect(selectsPbfElement(type, { shop: 'books' })).toBe(true);
      expect(selectsPbfElement(type, { shop: 'bakery' })).toBe(false);
      // the name regexes: on `name`, case-sensitive, unanchored, and only with
      // a shop/amenity tag present
      expect(selectsPbfElement(type, { shop: 'bakery', name: '서울레코드' })).toBe(true);
      expect(selectsPbfElement(type, { amenity: 'bar', name: 'LP바' })).toBe(true);
      expect(selectsPbfElement(type, { amenity: 'bar', name: 'lp바' })).toBe(false);
      expect(selectsPbfElement(type, { name: '음반가게' })).toBe(false);
      expect(selectsPbfElement(type, { tourism: 'hotel', name: '레코드' })).toBe(false);
    }
    // station and place nodes
    expect(selectsPbfElement('node', { railway: 'station' })).toBe(true);
    expect(selectsPbfElement('way', { railway: 'station' })).toBe(false);
    expect(selectsPbfElement('node', { station: 'subway' })).toBe(true);
    for (const place of ['square', 'neighbourhood', 'quarter', 'suburb']) {
      expect(selectsPbfElement('node', { place })).toBe(true);
    }
    expect(selectsPbfElement('node', { place: 'city' })).toBe(false);
    // way["place"="square"] — only square, only ways
    expect(selectsPbfElement('way', { place: 'square' })).toBe(true);
    expect(selectsPbfElement('way', { place: 'suburb' })).toBe(false);
    expect(selectsPbfElement('relation', { place: 'square' })).toBe(false);
    // no tags at all
    expect(selectsPbfElement('way', undefined)).toBe(false);
    expect(selectsPbfElement('way', {})).toBe(false);
  });
});

describe('PBF ↔ Overpass parity', () => {
  const options: BuildWorldOptions = { name: 'Seongsu slice', bbox: FIXTURE_BBOX };

  const overpassWorld = (): WorldData => {
    const raw = JSON.parse(readFileSync(fixture('seongsu-slice.overpass.json'), 'utf8')) as OverpassResponse;
    return buildWorldWithStats(raw, options).world;
  };

  it('builds the same world from the .osm.pbf slice as from the Overpass response', async () => {
    const extract = await extractOneFromPbf(fixture('seongsu-slice.osm.pbf'), FIXTURE_BBOX);
    const fromPbf = buildWorldWithStats(extract.raw, options).world;
    const fromOverpass = overpassWorld();

    // Per layer first: a failure here says which layer diverged, which is the
    // thing you want to know before staring at a 50-building diff.
    for (const layer of ['buildings', 'roads', 'water', 'parks', 'pois', 'stations', 'districts'] as const) {
      expect(`${layer}: ${fromPbf[layer].length}`).toBe(`${layer}: ${fromOverpass[layer].length}`);
    }
    expect(fromPbf).toEqual(fromOverpass);
  });

  it('emits the elements in Overpass order (nodes, ways, relations, each by id)', async () => {
    const { raw } = await extractOneFromPbf(fixture('seongsu-slice.osm.pbf'), FIXTURE_BBOX);
    const rank = { node: 0, way: 1, relation: 2 };
    let previous = { rank: -1, id: -Infinity };
    for (const el of raw.elements) {
      const current = { rank: rank[el.type], id: el.id };
      expect(current.rank).toBeGreaterThanOrEqual(previous.rank);
      if (current.rank === previous.rank) expect(current.id).toBeGreaterThan(previous.id);
      previous = current;
    }
    // Same element ids as Overpass returned, too.
    const overpass = JSON.parse(readFileSync(fixture('seongsu-slice.overpass.json'), 'utf8')) as OverpassResponse;
    const ids = (r: OverpassResponse): string[] => r.elements.map((e) => `${e.type[0]}${e.id}`);
    expect(ids(raw)).toEqual(ids(overpass));
  });

  it('serves several bboxes from one scan', async () => {
    const west: BBox = { ...FIXTURE_BBOX, east: 127.0557 };
    const east: BBox = { ...FIXTURE_BBOX, west: 127.0557 };
    const together = await extractFromPbf(fixture('seongsu-slice.osm.pbf'), [west, east]);
    const separately = [await extractOneFromPbf(fixture('seongsu-slice.osm.pbf'), west), await extractOneFromPbf(fixture('seongsu-slice.osm.pbf'), east)];
    expect(together).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      expect(together[i]!.raw.elements).toEqual(separately[i]!.raw.elements);
    }
    // and the halves really are different worlds
    expect(together[0]!.stats.ways).not.toBe(together[1]!.stats.ways);
  });

  it('records where the payload came from', async () => {
    const { raw, stats } = await extractOneFromPbf(fixture('seongsu-slice.osm.pbf'), FIXTURE_BBOX);
    expect(raw.maprama?.source).toBe('pbf');
    expect(raw.maprama?.bbox).toEqual(FIXTURE_BBOX);
    expect(stats.elements).toBe(raw.elements.length);
    expect(stats.missingNodes).toBe(0);
  });

  it('rejects an empty bbox list', async () => {
    await expect(extractFromPbf(fixture('seongsu-slice.osm.pbf'), [])).rejects.toThrow(/at least one bbox/);
  });
});

describe('surveyPbfNodes', () => {
  it('counts every node of the file into the cell it falls in', async () => {
    const counts = await surveyPbfNodes(fixture('seongsu-slice.osm.pbf'), 12);
    expect(counts.size).toBeGreaterThan(0);

    // The fixture is one small block, so the cells it touches must be the ones
    // its bbox covers — this is the property a nationwide plan relies on when it
    // decides a cell is empty and skips it.
    const n = 2 ** 12;
    const merc = (lat: number): number => {
      const s = Math.sin((lat * Math.PI) / 180);
      return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    };
    const x = Math.floor(((FIXTURE_BBOX.west + 180) / 360) * n);
    const y = Math.floor(merc(FIXTURE_BBOX.north) * n);
    expect(counts.get(`${x}/${y}`)).toBeGreaterThan(0);
    expect(counts.get('0/0')).toBeUndefined();

    // Every node, not just the selected ones: the survey is about where data is.
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const { raw } = await extractOneFromPbf(fixture('seongsu-slice.osm.pbf'), FIXTURE_BBOX);
    expect(total).toBeGreaterThan(raw.elements.filter((e) => e.type === 'node').length);
  });

  it('is deterministic', async () => {
    const a = await surveyPbfNodes(fixture('seongsu-slice.osm.pbf'), 10);
    const b = await surveyPbfNodes(fixture('seongsu-slice.osm.pbf'), 10);
    expect([...a].sort()).toEqual([...b].sort());
  });
});
